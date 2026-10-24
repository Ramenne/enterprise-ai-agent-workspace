import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {EventEmitter} from 'node:events';
import {createChatRepository} from '../server/business/chat-repository.mjs';
import {createDeviceRepository,createDeliveryDispatcher} from '../server/business/devices.mjs';
import {createNotificationEvents} from '../server/business/notification-events.mjs';
import {PROJECT} from '../server/business/native-authority.mjs';
const a={project_id:PROJECT,actor_id:'synthetic-a',display_name:'A',can_read:true,can_write:true};
const b={...a,actor_id:'synthetic-b',display_name:'B'};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function fixture(t){const db=new DatabaseSync(':memory:');const repo=createChatRepository(db);createDeviceRepository(db);t.after(()=>db.close());return {db,repo};}
function response(){const r=new EventEmitter();r.frames=[];r.writeHead=()=>{};r.write=s=>{r.frames.push(s);return true;};r.end=()=>{r.writableEnded=true;r.emit('close');};return r;}
const packets=r=>r.frames.map(f=>({type:/event: (.+)/.exec(f)?.[1],data:JSON.parse(/data: (.+)/.exec(f)?.[1]||'{}')}));
test('private wake reaches both participants including sender devices; unrelated members do not reread',async t=>{
 const {repo}=fixture(t),c={...a,actor_id:'synthetic-c'},counts={a:0,b:0,c:0},map={a,b,c};
 const events=createNotificationEvents(async cookie=>{counts[cookie]++;return map[cookie];},repo);t.after(()=>events.close());
 const ra=response(),rb=response(),rc=response();for(const [cookie,res] of [['a',ra],['b',rb],['c',rc]])await events.handle({url:'/business/v1/events',headers:{cookie}},res);
 await sleep(5);const before=counts.c,framesBefore=rc.frames.length;repo.send(a,{body:'private',recipient_username:b.actor_id},'private-event',{members:[a,b,c]});events.changed({actors:[a.actor_id,b.actor_id],message_participants:[a.actor_id,b.actor_id],message_kind:'chat_message',group_files_changed:false});await sleep(5);
 assert.equal(counts.c,before);assert.equal(rc.frames.length,framesBefore);
 assert.ok(packets(ra).some(p=>p.type==='change'&&p.data.kinds.includes('chat_message')&&!p.data.catchup&&p.data.conversation_peers.includes(b.actor_id)&&p.data.group_files_changed===false));assert.ok(packets(rb).some(p=>p.type==='change'&&p.data.notifications.length===1&&!p.data.catchup));
});
test('committed message becomes recipient-only live event; replay resumes the durable cursor',async t=>{
 const {repo}=fixture(t);const events=createNotificationEvents(async cookie=>cookie==='b'?b:a,repo);
 const ra=response(),rb=response();t.after(()=>events.close());
 await events.handle({url:'/business/v1/events',headers:{cookie:'a'}},ra);
 await events.handle({url:'/business/v1/events',headers:{cookie:'b'}},rb);
 const sent=repo.send(a,{body:'new message',mention_usernames:[b.actor_id]},'event-1',{members:[a,b]});events.changed();await sleep(5);
 const live=packets(rb).filter(p=>p.type==='change'&&p.data.notifications.length).at(-1);
 assert.equal(live.data.notifications[0].object_id,sent.message_id);assert.equal(live.data.catchup,false);
 assert.equal(live.data.notifications[0].recipient_actor,b.actor_id);
 assert.equal(packets(ra).flatMap(p=>p.data.notifications||[]).length,0);
 rb.end();const resumed=response();await events.handle({url:'/business/v1/events?after_version='+live.data.sync_version,headers:{cookie:'b'}},resumed);
 assert.equal(packets(resumed).flatMap(p=>p.data.notifications||[]).length,0);
});
test('backlog is paginated with resumable per-page cursor and authorization revocation terminates',async t=>{
 const {repo}=fixture(t);for(let i=0;i<205;i++)repo.send(a,{body:'message '+i},'page-'+i,{members:[a,b]});
 let allowed=true;const events=createNotificationEvents(async()=>{if(!allowed)throw Object.assign(Error(),{status:403});return b;},repo);
 t.after(()=>events.close());const res=response();await events.handle({url:'/business/v1/events',headers:{}},res);
 const pages=packets(res).filter(p=>p.type==='change'&&p.data.catchup);assert.deepEqual(pages.map(p=>p.data.notifications.length),[100,100,5]);
 assert.ok(pages.every(p=>p.data.catchup));assert.ok(pages.flatMap(p=>p.data.notifications).every(n=>n.snapshot.silent===false));assert.equal(pages.at(-1).data.sync_version,205);
 allowed=false;events.changed();await sleep(5);assert.equal(packets(res).at(-1).type,'auth');assert.ok(res.writableEnded);
});
test('persisted push backlog drains past one batch without another web request',async t=>{
 const {db,repo}=fixture(t);db.prepare('INSERT INTO device_bindings VALUES(?,?,?,?,?,NULL)').run('d',b.actor_id,'ios_web_push','{}',1);
 for(let i=0;i<101;i++)repo.send(a,{body:'message '+i,mention_usernames:[b.actor_id]},'push-'+i,{members:[a,b]});
 let delivered=0;const drain=createDeliveryDispatcher(db,{async deliver(){delivered++;return {state:'provider_accepted'};}},{directory:async()=>[b]});
 t.after(()=>drain.close());await sleep(100);assert.equal(delivered,101);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM delivery_outbox WHERE state='queued'").get().n,0);
});
test('retired snooze cannot be set; old deadlines are cleared without deleting notices',t=>{
 const {db,repo}=fixture(t);repo.send(a,{body:'old reminder'},'retire',{members:[a,b]});const n=repo.notifications(b).notifications[0];
 assert.throws(()=>repo.notificationAction(b,n.id,'snooze',{until:2000},'snooze'),e=>e.code==='unsupported_notification_action');
 db.prepare('UPDATE notifications SET snooze_until=2000 WHERE id=?').run(n.id);
 createChatRepository(db);assert.equal(repo.notifications(b).notifications[0].snooze_until,null);assert.equal(db.prepare('SELECT COUNT(*) n FROM notifications WHERE id=?').get(n.id).n,1);
});
test('reading a notification during delivery authorization prevents a stale external alert',async t=>{
 const {db,repo}=fixture(t);db.prepare('INSERT INTO device_bindings VALUES(?,?,?,?,?,NULL)').run('d',b.actor_id,'ios_web_push','{}',1);
 repo.send(a,{body:'read before send'},'read-race',{members:[a,b]});const n=repo.notifications(b).notifications[0];
 let calls=0,release;const delivered=[];
 const directory=async()=>{if(++calls===2)return new Promise(r=>release=r);return [b];};
 const drain=createDeliveryDispatcher(db,{async deliver(_s,n){delivered.push(n);return {state:'provider_accepted'};}},{directory});t.after(()=>drain.close());
 await sleep(5);assert.equal(typeof release,'function');repo.notificationAction(b,n.id,'read',{},'read-race-action');release([b]);await sleep(10);
 assert.equal(delivered.filter(n=>!n.state_only).length,0,'read must suppress the original alert');assert.equal(delivered.length,1,'a silent state update must still reach the other device');assert.equal(delivered[0].state_only,true);assert.equal(db.prepare("SELECT state FROM delivery_outbox WHERE id NOT LIKE 'state:%'").get().state,'expired');
});

test('idle heartbeats do not query authority or data; a real change still checks authority',async t=>{
 const {repo}=fixture(t);let outage=false,authorityReads=0,dataReads=0;
 const original=repo.notifications.bind(repo);repo.notifications=(...args)=>{dataReads++;return original(...args);};
 const events=createNotificationEvents(async()=>{authorityReads++;if(outage)throw Object.assign(Error('dependency unavailable'),{status:503});return b;},repo,{heartbeatMs:5});t.after(()=>events.close());
 const res=response();await events.handle({url:'/business/v1/events',headers:{cookie:'synthetic'}},res);
 const before={authorityReads,dataReads};outage=true;await sleep(30);
 assert.ok(packets(res).filter(x=>x.type==='ping').length>=2);
 assert.deepEqual({authorityReads,dataReads},before,'idle transport checks cannot make upstream or repository requests');
 assert.ok(!res.writableEnded);assert.ok(!packets(res).some(x=>['auth','error'].includes(x.type)));
 events.changed({actors:[b.actor_id],message_kind:'chat_message'});await sleep(5);
 assert.equal(authorityReads,before.authorityReads+1);assert.equal(dataReads,before.dataReads);
 assert.equal(packets(res).at(-1).type,'error');assert.equal(packets(res).at(-1).data.status,503);assert.ok(res.writableEnded);
});

test('self assistant wakes both owner devices with the self peer and creates no recipient notification',async t=>{
 const {repo}=fixture(t),events=createNotificationEvents(async()=>a,repo);t.after(()=>events.close());
 const first=response(),second=response();for(const res of [first,second])await events.handle({url:'/business/v1/events',headers:{}},res);
 repo.send(a,{body:'self assistant',recipient_username:a.actor_id},'self-assistant',{members:[a,b]});events.changed({actors:[a.actor_id,a.actor_id],message_participants:[a.actor_id,a.actor_id],message_kind:'chat_message',group_files_changed:false});await sleep(5);
 for(const res of [first,second]){const change=packets(res).filter(p=>p.type==='change'&&!p.data.catchup&&p.data.kinds.includes('chat_message')).at(-1);assert.deepEqual(change.data.conversation_peers,[a.actor_id]);assert.deepEqual(change.data.notifications,[]);assert.equal(change.data.group_files_changed,false);}
});

test('subscription expiry wakes only its owner to repair and does not change message read state',async t=>{
 const {db,repo}=fixture(t),devices=createDeviceRepository(db),sub={endpoint:'https://web.push.apple.com/live-expiry',keys:{p256dh:'A'.repeat(87),auth:'B'.repeat(22)}};
 devices.bind(b,{installation_id:'live-expiry',platform:'ios_web_push',subscription:sub});const events=createNotificationEvents(async cookie=>cookie==='b'?b:a,repo);t.after(()=>events.close());
 const ra=response(),rb=response();for(const [cookie,res] of [['a',ra],['b',rb]])await events.handle({url:'/business/v1/events',headers:{cookie}},res);
 const beforeA=ra.frames.length;repo.send(a,{body:'unread remains during repair'},'live-expiry',{members:[a,b]});
 await createDeliveryDispatcher(db,{deliver:async()=>({state:'subscription_expired',provider_status:410})},{onSubscriptionExpired:actor=>events.changed({actors:[actor],push_subscription_expired:true})})(async()=>[a,b]);await sleep(5);
 assert.equal(ra.frames.length,beforeA);assert.ok(packets(rb).some(p=>p.data.kinds?.includes('push_subscription_expired')));assert.equal(repo.notifications(b).notifications[0].read_at,null);
});

// Isolated engineering validation only. No production database, identity or push.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {createChatRepository} from '../server/business/chat-repository.mjs';
import {createHubNoticeStore} from '../server/business/hub-notifications.mjs';
import {createNotificationEvents} from '../server/business/notification-events.mjs';
const input=JSON.parse(await readFile(process.argv[2],'utf8'));
assert.equal(input.source,'actual_member_authorized_transaction_sse');
assert.equal(input.snapshots.length,2);
const members=input.members.filter(m=>m.can_read===true);
assert.ok(members.length>=2);
const dir=await mkdtemp(join(tmpdir(),'qn-cloud-notify-'));
let db,events,server;const clients=[];
async function connect(base,actor,after=0){
 const ctl=new AbortController();clients.push(ctl);
 const response=await fetch(base+'/business/v1/events?after_version='+after,{headers:{'x-validation-actor':actor},signal:ctl.signal});
 assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/event-stream/);
 const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
 return {close(){ctl.abort();},async next(){for(;;){const end=buffer.indexOf('\n\n');if(end>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);return {type:/^event: (.+)$/m.exec(frame)?.[1],data:JSON.parse(/^data: (.+)$/m.exec(frame)?.[1]||'{}')};}const part=await reader.read();if(part.done)throw Error('unexpected_stream_end');buffer+=decoder.decode(part.value,{stream:true});assert.ok(buffer.length<2*1024*1024);}}};
}
try{
 const path=join(dir,'isolated.sqlite');db=new DatabaseSync(path);
 let repo=createChatRepository(db),store=createHubNoticeStore(db);
 const simulation={actor_id:'cloud-isolated-validation-service-simulation'};
 assert.equal(store.apply(simulation,input.snapshots[0],members).state,'baseline');
 const a={...members[0],project_id:input.project_id},b={...members[1],project_id:input.project_id};
 const authorized=new Map(members.map(m=>[m.actor_id,{...m,project_id:input.project_id}]));
 let requestActor;
 events=createNotificationEvents(async actor=>{const ctx=authorized.get(actor);if(!ctx)throw Object.assign(Error('simulation_rejected'),{status:403});return ctx;},repo);
 server=createServer((req,res)=>{req.headers.cookie=req.headers['x-validation-actor']||'';events.handle(req,res).catch(()=>{res.writeHead(403);res.end();});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const active=await connect(base,a.actor_id);assert.equal((await active.next()).type,'ready');assert.equal((await active.next()).data.notifications.length,0);
 const old=await connect(base,b.actor_id);await old.next();await old.next();old.close();
 const changed=store.apply(simulation,input.snapshots[1],members);assert.equal(changed.created,members.length);events.changed();
 const live=await active.next();assert.equal(live.type,'change');assert.equal(live.data.catchup,false);
 assert.equal(live.data.notifications.length,1);assert.equal(live.data.notifications[0].recipient_actor,a.actor_id);
 assert.equal(live.data.notifications[0].kind,'hub_update');
 const resumed=await connect(base,b.actor_id);await resumed.next();const catchup=await resumed.next();assert.equal(catchup.data.catchup,true);
 assert.equal(catchup.data.notifications.length,1);assert.equal(catchup.data.notifications[0].recipient_actor,b.actor_id);
 const current=await connect(base,b.actor_id,catchup.data.sync_version);await current.next();assert.equal((await current.next()).data.notifications.length,0);
 assert.equal(repo.messages(a).messages.length,0);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM delivery_outbox').get().n,members.length);
 for(const c of clients)c.abort();events.close();await new Promise(r=>server.close(r));server=null;db.close();
 db=new DatabaseSync(path);repo=createChatRepository(db);store=createHubNoticeStore(db);
 assert.equal(store.apply(simulation,input.snapshots[1],members).created,0);
 assert.equal(repo.notifications(a).notifications.length,1);
 assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');
 console.log(JSON.stringify({state:'verified',environment:'isolated_cloud_database_and_loopback_HTTP',actual_source:'real_hub_transaction_snapshots',real_members:members.length,notification_count:members.length,checks:['initial_baseline_no_history_spam','active_recipient_SSE','offline_recipient_catchup','cursor_resume_no_duplicate','persistent_database_reopen','snapshot_replay_dedup','recipient_isolation','no_fake_chat','outbox_persisted'],production_config_changed:false,production_service_restarted:false,production_database_written:false,product_service_identity_verified:false,external_push_sent:false}));
}finally{for(const c of clients)c.abort();events?.close();server?.closeAllConnections();if(server)await new Promise(r=>server.close(r));db?.close();await rm(dir,{recursive:true,force:true});}

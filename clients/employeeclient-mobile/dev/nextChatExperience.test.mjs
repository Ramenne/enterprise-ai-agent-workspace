import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {EventEmitter} from 'node:events';
import {createChatRepository} from '../server/business/chat-repository.mjs';
import {createNotificationEvents} from '../server/business/notification-events.mjs';
import {PROJECT} from '../server/business/native-authority.mjs';
import {createImageGesture} from '../src/chat/imageGesture.mjs';
const ctx=id=>({project_id:PROJECT,actor_id:id,display_name:id,can_read:true,can_write:true,can_publish_announcement:id==='m'});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function response(){const r=new EventEmitter();r.frames=[];r.writeHead=()=>{};r.write=x=>{r.frames.push(x);return true;};r.end=()=>{r.writableEnded=true;r.emit('close');};return r;}
const packets=r=>r.frames.map(f=>({type:/event: (.+)/.exec(f)?.[1],data:JSON.parse(/data: (.+)/.exec(f)?.[1]||'{}')}));
test('group file pagination skips recordings and photos while retaining uploaded audio documents and chat originals',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const repo=createChatRepository(db),members=[{actor_id:'a'},{actor_id:'b'}];
 const file=(id,name,mime,purpose)=>({id,name,mime,purpose,fixed_ref:{project_id:PROJECT,material_id:id,version_id:'v1'}});
 const send=(attachment,key)=>repo.send(ctx('a'),{body:'',attachment_ids:[attachment.id]},key,{members,attachments:[attachment]});
 send(file('doc','工作.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','file'),'doc');
 for(let i=0;i<60;i++)send(file('voice'+i,'语音.webm','audio/webm','voice'),'voice'+i);
 send(file('legacy','语音-2026-10-11T06-00-00-000Z.m4a','audio/mp4'),'legacy');
 send(file('photo','相册.jpg','application/octet-stream','file'),'photo');
 send(file('music','会议音频.m4a','audio/mp4','file'),'music');
 const first=repo.files(ctx('b'),{limit:1});assert.deepEqual(first.files.map(a=>a.id),['music']);assert.ok(first.next_cursor);
 const second=repo.files(ctx('b'),{limit:1,before:first.next_cursor});assert.deepEqual(second.files.map(a=>a.id),['doc']);assert.equal(second.next_cursor,null);
 assert.equal(repo.messages(ctx('b'),{limit:100}).messages.length,64);
});
test('read receipt wakes publisher immediately without a fake notice; quiet heartbeats never query the business inbox',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const repo=createChatRepository(db),members=['m','a','b'].map(actor_id=>({actor_id}));
 const ann=repo.publishAnnouncement(ctx('m'),{title:'公告',body:'正文',recipient_usernames:['a']},'publish',members),note=repo.announcement(ctx('a'),ann.announcement_id);
 let queries=0;const notifications=repo.notifications;repo.notifications=(...args)=>{queries++;return notifications(...args);};
 const events=createNotificationEvents(async cookie=>ctx(cookie),repo,{heartbeatMs:5});t.after(()=>events.close());const sender=response(),recipient=response(),outside=response();
 await events.handle({url:'/business/v1/events',headers:{cookie:'m'}},sender);await events.handle({url:'/business/v1/events',headers:{cookie:'a'}},recipient);await events.handle({url:'/business/v1/events',headers:{cookie:'b'}},outside);
 sender.frames=[];recipient.frames=[];outside.frames=[];const quiet=queries;await delay(20);assert.equal(queries,quiet);assert.ok(packets(sender).some(p=>p.type==='ping'));
 repo.notificationAction(ctx('a'),note.notification_id,'read',{},'read');events.changed(repo.notificationWake(ctx('a'),note.notification_id,'read'));await delay(5);
 assert.ok(packets(sender).some(p=>p.type==='change'&&p.data.kinds?.includes('announcement_read')&&p.data.announcement_ids[0]===ann.announcement_id));
 assert.ok(!packets(outside).some(p=>p.data.announcement_ids));assert.equal(repo.notifications(ctx('m')).notifications.length,0);assert.equal(repo.announcement(ctx('m'),ann.announcement_id).read_count,1);
});
test('image pinch anchors and finger release remain stable with freely pannable bounds',()=>{
 const g=createImageGesture();g.configure({width:200,height:300,viewportWidth:390,viewportHeight:700});
 g.begin(1,{x:-40,y:0});g.begin(2,{x:40,y:0});g.move(2,{x:200,y:0});
 assert.deepEqual(g.snapshot(),{scale:3,x:80,y:0});
 g.end(2);g.move(1,{x:-30,y:0});assert.equal(g.snapshot().x,90);
 g.move(1,{x:2000,y:2000});const s=g.snapshot();
 // Even at the pan limit part of the image stays visible in both directions.
 assert.ok(s.x<390/2+200*s.scale/2);assert.ok(s.y<700/2+300*s.scale/2);
 g.end(1);assert.deepEqual(g.reset(),{scale:1,x:0,y:0});
 g.zoomTo(99);assert.equal(g.snapshot().scale,5);
});
test('image can pinch smaller than fit and drag on both axes without jumping after finger release',()=>{
 const g=createImageGesture();g.configure({width:200,height:300,viewportWidth:390,viewportHeight:700});
 g.begin(1,{x:-80,y:0});g.begin(2,{x:80,y:0});g.move(2,{x:0,y:0});
 assert.deepEqual(g.snapshot(),{scale:0.5,x:-40,y:0});
 g.end(2);g.move(1,{x:-20,y:90});assert.deepEqual(g.snapshot(),{scale:0.5,x:20,y:90});
 g.end(1);g.zoomTo(0);assert.equal(g.snapshot().scale,0.25);
 assert.deepEqual(g.reset(),{scale:1,x:0,y:0});
});

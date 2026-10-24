import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as qnExperienceCrypto from 'node:crypto';
import * as qnExperienceEvents from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';
import {PROJECT,assertActorNeutralBody,assertBusinessWrite} from '../server/business/native-authority.mjs';
import {notificationTarget} from '../server/business/notification-target.mjs';
const file=new URL('../../成员状态与账号设置候选-v88-20261011/server/gateway.runtime.mjs',import.meta.url);
function moduleFactory(bundle,marker,factory,init){
 const start=bundle.indexOf('// server/business/'+marker+'.mjs'),end=bundle.indexOf('// server/business/',start+45),part=bundle.slice(start,end).replace(/^import[^\n]+\n/gm,'');
 const __esm=object=>()=>object[Object.keys(object)[0]]();
 const deps={PROJECT,assertActorNeutralBody,assertBusinessWrite,notificationTarget,__esm,qnExperienceCrypto,qnExperienceEvents};
 for(const name of part.matchAll(/\b(init_\w+)\(\);/g))if(name[1]!==init)deps[name[1]]=()=>{};
 for(const name of bundle.slice(start,end).matchAll(/createHash as (\w+)/g))deps[name[1]]=createHash;
 for(const name of bundle.slice(start,end).matchAll(/randomUUID as (\w+)/g))deps[name[1]]=randomUUID;
 return new Function(...Object.keys(deps),part+`;${init}();return ${factory};`)(...Object.values(deps));
}
test('next narrow runtime candidate preserves scoped announcement HTTP and receipt behavior',async t=>{
 const bundle=await readFile(file,'utf8'),repositoryFactory=moduleFactory(bundle,'chat-repository','createChatRepository','init_chat_repository'),handlerFactory=moduleFactory(bundle,'http','createBusinessHandler','init_http');
 const db=new DatabaseSync(':memory:'),repo=repositoryFactory(db),context=id=>({actor_id:id,project_id:PROJECT,can_read:true,can_write:true,can_publish_announcement:id==='sender',display_name:id==='sender'?'发布者':'接收人'}),members=['sender','recipient','stranger'].map(actor_id=>({actor_id,can_read:true}));
 const handler=handlerFactory({repository:repo,authorize:async cookie=>context(cookie),directory:async()=>members,resolveReference:async()=>null,resolveAttachments:async()=>[]});
 const server=createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));db.close();});
 async function call(actor,path,body,key){const r=await fetch('http://127.0.0.1:'+server.address().port+'/business/v1/'+path,{method:body===undefined?'GET':'POST',headers:{cookie:actor,...(body===undefined?{}:{'content-type':'application/json','idempotency-key':key})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};}
 const sent=await call('sender','announcements',{title:'冻结运行代码公告',body:'真实候选运行代码的正文',priority:'normal',recipient_usernames:['recipient']},'frozen-send');assert.equal(sent.status,201);const id=sent.body.announcement_id;
 const detail=await call('recipient','announcements/'+id);assert.equal(detail.status,200);assert.equal(detail.body.announcement.body,'真实候选运行代码的正文');assert.equal(detail.body.announcement.audience,undefined);
 assert.equal((await call('stranger','announcements/'+id)).status,404);
 const read=await call('recipient','notifications/'+detail.body.announcement.notification_id+'/read',{},'frozen-read');assert.equal(read.status,200);
 const received=await call('sender','announcements/'+id);assert.equal(received.body.announcement.read_count,1);assert.equal(received.body.announcement.unread_count,0);assert.equal(received.body.announcement.audience.length,1);
 const list=await call('sender','announcements');assert.equal(list.body.announcements[0].id,id);
});

test('all runtime code outside the three patched modules and the event hook is preserved',async()=>{
 const before=await readFile(new URL('../../真机反馈统一整改候选-v86-20261011/server/gateway.runtime.mjs',import.meta.url),'utf8'),after=await readFile(file,'utf8');
 function normalize(text){for(const marker of ['chat-repository','http','notification-events','notification-reminders']){const start=text.indexOf('// server/business/'+marker+'.mjs');if(start<0)continue;const end=text.indexOf('// server/business/',start+45);text=text.slice(0,start)+text.slice(end);}return text.replace(/^import \* as qnExperience[^\n]*\n/gm,'').replace('const changed = (hint) => {\n    events.changed(hint);','const changed = () => {\n    events.changed();').replace(/  const reminders = createNotificationReminders\(db, \(\) => \{\n    events.changed\(\);\n    drain.wake\(\);\n  \}\);\n  reminders.wake\(\);\n/,'').replaceAll('    reminders.wake();\n','').replaceAll('    reminders.close();\n','').replaceAll('    init_notification_reminders();\n','').replace('    member_roster: members,\n','');}
 assert.equal(createHash('sha256').update(normalize(after)).digest('hex'),createHash('sha256').update(normalize(before)).digest('hex'));
});
test('narrow runtime read event reaches publisher, skips reading member hint, and does not query outsiders',async()=>{
 const bundle=await readFile(file,'utf8'),factory=moduleFactory(bundle,'chat-repository','createChatRepository','init_chat_repository'),eventFactory=moduleFactory(bundle,'notification-events','createNotificationEvents','init_notification_events');
 const db=new DatabaseSync(':memory:'),repo=factory(db),actor=id=>({actor_id:id,project_id:PROJECT,can_read:true,can_write:true,can_publish_announcement:id==='m',display_name:id});
 const receipt=repo.publishAnnouncement(actor('m'),{title:'新公告',body:'正文',recipient_usernames:['a']},'ann-event',['m','a','b'].map(actor));
 const calls=new Map(),wrapped={...repo,notifications:(ctx,...args)=>{calls.set(ctx.actor_id,(calls.get(ctx.actor_id)||0)+1);return repo.notifications(ctx,...args);}};
 const events=eventFactory(async cookie=>actor(cookie),wrapped),responses={};
 try{
  for(const id of ['m','a','b']){const res=new qnExperienceEvents.EventEmitter();res.frames=[];res.writeHead=()=>{};res.write=s=>{res.frames.push(s);return true;};res.end=()=>{res.writableEnded=true;res.emit('close');};responses[id]=res;await events.handle({url:'/business/v1/events',headers:{cookie:id}},res);res.frames=[];}
  const n=repo.announcement(actor('a'),receipt.announcement_id).notification_id;
  repo.notificationAction(actor('a'),n,'read',{},'read');events.changed(repo.notificationWake(actor('a'),n,'read'));await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));
  assert.ok(responses.m.frames.some(s=>s.includes('announcement_read')));assert.ok(!responses.a.frames.some(s=>s.includes('announcement_read')));assert.equal(calls.get('b'),1,'unrelated member performs no inbox read');
  const aCalls=calls.get('a');events.changed(repo.notificationWake(actor('a'),n,'pin'));await new Promise(r=>setImmediate(r));assert.equal(calls.get('a'),aCalls+1);assert.equal(calls.get('b'),1);
 }finally{events.close();db.close();}
});
test('frozen member profile routes enforce self ownership, serve snapshots without repeat directory auth, and persist avatar bytes',async()=>{
 const bundle=await readFile(file,'utf8'),repoFactory=moduleFactory(bundle,'chat-repository','createChatRepository','init_chat_repository'),handlerFactory=moduleFactory(bundle,'http','createBusinessHandler','init_http');
 const db=new DatabaseSync(':memory:'),repo=repoFactory(db),roster=[{actor_id:'a',display_name:'A',can_read:true},{actor_id:'b',display_name:'B',can_read:true}],actor=id=>({actor_id:id,project_id:PROJECT,can_read:true,can_write:true,member_roster:roster});let auths=0;
 const handler=handlerFactory({repository:repo,authorize:async cookie=>{auths++;if(cookie==='outsider')throw Object.assign(Error(),{status:403});return actor(cookie);},directory:async()=>{throw Error('member snapshot should not be queried again');},resolveReference:async()=>null,resolveAttachments:async()=>[],onChange:()=>{}});
 // JPEG SOF segment fixture; the browser's actual normalized-photo path is checked in the local UI.
 const jpeg=Buffer.from([255,216,255,192,0,17,8,0,1,0,1,3,1,17,0,2,17,0,3,17,0,255,217]);
 const server=createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const call=async(id,path,body)=>{const r=await fetch('http://127.0.0.1:'+server.address().port+'/business/v1/'+path,{method:body?'POST':'GET',headers:{cookie:id,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};};
 try{
  const members=await call('a','members');assert.equal(members.status,200);assert.equal(members.body.members.length,2);assert.equal(auths,1);assert.ok(members.body.members.every(m=>typeof m.online==='boolean'));
  const first=repo.profiles.open('a'),second=repo.profiles.open('a');assert.equal(repo.profiles.member(roster[0]).online,true);assert.equal(repo.profiles.close('a',first.token),false);assert.equal(repo.profiles.close('a',second.token),true);assert.ok(repo.profiles.member(roster[0]).last_seen_at>0);
  const photo={mime:'image/jpeg',bytes_base64:jpeg.toString('base64')};const updated=await call('a','profile/avatar',photo);assert.equal(updated.status,200);assert.equal(updated.body.actor_id,'a');assert.equal(repo.profiles.member(roster[0]).avatar_version,updated.body.avatar_version);
  const forged=await call('a','profile/avatar',{...photo,actor_id:'b'});assert.equal(forged.status,400);assert.equal(repo.profiles.member(roster[1]).avatar_version,null);
  assert.equal((await call('outsider','members/a/avatar')).status,403);
  assert.equal((await call('a','profile/avatar',{mime:'image/svg+xml',bytes_base64:'test'})).status,400);
  const reopened=repoFactory(db);assert.equal(reopened.profiles.avatar('a').data_url,'data:image/jpeg;base64,'+photo.bytes_base64);
 }finally{await new Promise(r=>server.close(r));db.close();}
});

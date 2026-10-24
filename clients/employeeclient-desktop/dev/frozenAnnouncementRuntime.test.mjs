import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';
import {PROJECT,assertActorNeutralBody,assertBusinessWrite} from '../server/business/native-authority.mjs';
import {notificationTarget} from '../server/business/notification-target.mjs';
const file=new URL('../../真机反馈统一整改候选-v86-20261011/server/gateway.runtime.mjs',import.meta.url);
function moduleFactory(bundle,marker,factory,init){
 const start=bundle.indexOf('// server/business/'+marker+'.mjs'),end=bundle.indexOf('// server/business/',start+45),part=bundle.slice(start,end).replace(/^import[^\n]+\n/gm,'');
 const __esm=object=>()=>object[Object.keys(object)[0]]();
 const deps={PROJECT,assertActorNeutralBody,assertBusinessWrite,notificationTarget,__esm};
 for(const name of part.matchAll(/\b(init_\w+)\(\);/g))if(name[1]!==init)deps[name[1]]=()=>{};
 for(const name of bundle.slice(start,end).matchAll(/createHash as (\w+)/g))deps[name[1]]=createHash;
 for(const name of bundle.slice(start,end).matchAll(/randomUUID as (\w+)/g))deps[name[1]]=randomUUID;
 return new Function(...Object.keys(deps),part+`;${init}();return ${factory};`)(...Object.values(deps));
}
test('frozen runtime patch, not a fresh unrelated rebuild, serves the announcement detail and receipts over HTTP',async t=>{
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

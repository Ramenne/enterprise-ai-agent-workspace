import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createLocalScenario} from './reconstruction-local.mjs';
test('actual local HTTP publish -> sender/recipient lists -> detail -> read -> receipt; strangers and missing records rejected',async t=>{
 const scenario=createLocalScenario(),server=createServer(scenario.businessHandler);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>server.close(r));scenario.close();});
 const origin='http://127.0.0.1:'+server.address().port;
 async function call(actor,path,body,key){const response=await fetch(origin+'/business/v1/'+path,{method:body===undefined?'GET':'POST',headers:{cookie:'simulation_member='+actor,...(body===undefined?{}:{'content-type':'application/json','idempotency-key':key})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json()};}
 const publication=await call('sim-m','announcements',{title:'端到端公告',body:'可打开的正文',recipient_usernames:['sim-a'],priority:'normal'},'http-publication');assert.equal(publication.status,201);const id=publication.body.announcement_id;
 const repeated=await call('sim-m','announcements',{title:'端到端公告',body:'可打开的正文',recipient_usernames:['sim-a'],priority:'normal'},'http-publication');assert.equal(repeated.body.announcement_id,id);
 const sender=await call('sim-m','announcements');assert.equal(sender.body.announcements.find(x=>x.id===id).unread_count,1);
 const recipient=await call('sim-a','announcements/'+id);assert.equal(recipient.status,200);assert.equal(recipient.body.announcement.body,'可打开的正文');assert.equal(recipient.body.announcement.audience,undefined);
 assert.equal((await call('sim-b','announcements/'+id)).status,404);assert.equal((await call('sim-a','announcements/missing')).status,404);
 const read=await call('sim-a','notifications/'+recipient.body.announcement.notification_id+'/read',{},'http-read');assert.equal(read.status,200);
 const receipt=await call('sim-m','announcements/'+id);assert.equal(receipt.body.announcement.read_count,1);assert.equal(receipt.body.announcement.unread_count,0);assert.equal(receipt.body.announcement.audience[0].username,'sim-a');
 const denied=await call('sim-a','announcements',{title:'不能绕过资格',body:'正文',recipient_usernames:['sim-b']},'bad');assert.equal(denied.status,403);
});

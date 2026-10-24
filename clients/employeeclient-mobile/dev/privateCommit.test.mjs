import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {createGateway} from '../server/gateway.mjs';import {createRuntimeHandler} from '../server/business/runtime.mjs';import {PROJECT} from '../server/business/native-authority.mjs';
test('combined private commit keeps owner/peer boundaries, one message on replay, and checks revocation before send',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const members=['a','b','c'].map(actor_id=>({actor_id,can_read:true,can_write:true}));let revoke=false;
 const fixed={material_id:'cfe3f0af-af84-4c63-a0d6-2d0677caaddd',version_id:'8662ae87-2e86-405e-aa76-c2b6e807b0b1',sha256:'a'.repeat(64),size:19};
 const sessionFactory=async actor=>({context:{actor_id:actor,display_name:actor,project_id:PROJECT,can_read:true,can_write:!revoke,member_roster:members},directory:async()=>members,rpc:async()=>({fixed_ref:fixed})});
 const runtime=createRuntimeHandler(db,{sessionFactory});const server=createGateway({publicOrigin:'https://test.invalid',businessHandler:runtime});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
 const call=async(actor,path,body,key)=>{const r=await fetch('http://127.0.0.1:'+server.address().port+'/business/v1/'+path,{method:body?'POST':'GET',headers:{cookie:actor,origin:'https://test.invalid','content-type':'application/json',...(key?{'idempotency-key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};};
 const grant=(await call('a','private-attachments',{peer:'b',name:'voice.wav',mime:'audio/wav',size:3,sha256:'b'.repeat(64),purpose:'voice'},'upload')).body;
 const request={fixed_ref:fixed,message:{body:'',recipient_username:'b',attachment_ids:[],mention_usernames:[]}};
 assert.equal((await call('b','private-attachments/'+grant.id)).status,404);
 assert.equal((await call('b','private-attachments/'+grant.id+'/commit',request,'send')).status,404);
 assert.equal((await call('a','private-attachments/'+grant.id+'/commit',{...request,message:{...request.message,recipient_username:'c'}},'wrong')).status,403);
 const sent=await call('a','private-attachments/'+grant.id+'/commit',request,'send');assert.equal(sent.status,201,JSON.stringify(sent.body));assert.equal(sent.body.message.attachments[0].id,'private:'+grant.id);
 const replay=await call('a','private-attachments/'+grant.id+'/commit',request,'send');assert.equal(replay.status,201);assert.equal(replay.body.message.id,sent.body.message.id);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,1);
 assert.equal((await call('b','private-attachments/'+grant.id)).status,200);assert.equal((await call('c','private-attachments/'+grant.id)).status,404);
 assert.equal((await call('a','private-attachments/'+grant.id+'/commit',{...request,message:{...request.message,actor_id:'b'}},'forged')).status,400);
 revoke=true;assert.equal((await call('a','private-attachments/'+grant.id+'/commit',request,'new-send')).status,403);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,1);
});

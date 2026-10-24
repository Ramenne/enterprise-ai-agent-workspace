import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {createHash} from 'node:crypto';
import {createRuntimeHandler} from '../server/business/runtime.mjs';import {createGateway} from '../server/gateway.mjs';import {PROJECT} from '../server/business/native-authority.mjs';
import {encryptedSource,encryptedSize,PRIVATE_BLOCK} from '../shared/private-media.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const a={actor_id:'a',display_name:'A',project_id:PROJECT,can_read:true,can_write:true},b={...a,actor_id:'b'},c={...a,actor_id:'c'},members=[a,b,c];
async function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());let bytes,fixed,revoked=false,streamCalls=0;
 const handler=createRuntimeHandler(db,{sessionFactory:async cookie=>{if(revoked)throw Object.assign(Error('revoked'),{status:403,code:'project_read_denied'});return {context:members.find(m=>m.actor_id===cookie),directory:async()=>members,rpc:async name=>{assert.equal(name,'mem.version.read');return {fixed_ref:fixed};},fileStream:async()=>{streamCalls++;return new Response(bytes);}};}});
 t.after(()=>handler.close());const server=createGateway({publicOrigin:'https://test.invalid',businessHandler:handler});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});const base='http://127.0.0.1:'+server.address().port;
 const call=(actor,path,body,key='operation')=>fetch(base+'/business/v1/'+path,{method:body===undefined?'GET':'POST',headers:{cookie:actor,origin:'https://test.invalid',...(body===undefined?{}:{'content-type':'application/json','idempotency-key':key})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 async function upload(plain,purpose='file'){
  const input={peer:'b',name:purpose==='voice'?'voice.webm':'私聊图片.png',mime:purpose==='voice'?'audio/webm':'image/png',size:plain.length,sha256:sha(plain),purpose,...(purpose==='voice'?{duration_ms:3000}:{})};
  const grant=await(await call('a','private-attachments',input,'upload')).json();assert.ok(grant.key_base64);
  const same=await(await call('a','private-attachments',input,'upload')).json();assert.deepEqual(same,grant);
  assert.equal((await call('a','private-attachments',{...input,peer:'c'},'upload')).status,409);
  const source=await encryptedSource(new Blob([plain]),grant);bytes=Buffer.from(await(await source.readPart(0,source.size)).arrayBuffer());assert.equal(bytes.length,encryptedSize(plain.length));assert.notDeepEqual(bytes,plain);
  fixed={project_id:PROJECT,material_id:'cfe3f0af-af84-4c63-a0d6-2d0677caaddd',version_id:'8662ae87-2e86-405e-aa76-c2b6e807b0b1',sha256:sha(bytes),size:bytes.length};
  const bound=await call('a','private-attachments/'+grant.id+'/bind',{fixed_ref:fixed});assert.equal(bound.status,200);const attachment=(await bound.json()).attachment;
  assert.equal((await call('b','private-attachments/'+grant.id)).status,404);assert.equal((await call('c','private-attachments/'+grant.id+'/bind',{fixed_ref:fixed})).status,404);
  const response=await call('a','messages',{body:'',attachment_ids:[attachment.id],recipient_username:'b'},'send');assert.equal(response.status,201);const message=(await response.json()).message;assert.equal(message.attachments[0].size,plain.length);assert.equal(JSON.stringify(message).includes(grant.key_base64),false);
  assert.equal((await call('a','messages',{body:'',attachment_ids:[attachment.id]},'leak')).status,403);assert.equal((await call('a','messages',{body:'',attachment_ids:[attachment.id],recipient_username:'c'},'leak-peer')).status,403);
  return {grant,message,input,source};
 }
 return {db,call,upload,revoke:()=>revoked=true,corrupt:()=>{bytes[0]^=1;},streamCalls:()=>streamCalls};
}
test('private image/file sends retain plaintext hash, exclude third members, group files, keys and revoked readers',async t=>{
 const f=await fixture(t),plain=Buffer.alloc(PRIVATE_BLOCK+37,23),{grant,message,source}=await f.upload(plain);
 assert.equal((await source.readPart(PRIVATE_BLOCK+9,PRIVATE_BLOCK+39)).size,30);
 const head=await(await f.call('b','private-attachments/'+grant.id)).json();assert.equal(head.attachment.sha256,sha(plain));assert.equal(head.key_base64,undefined);
 assert.equal((await f.call('c','private-attachments/'+grant.id+'/file')).status,404);assert.equal(f.streamCalls(),0);
 const download=await f.call('b','private-attachments/'+grant.id+'/file');assert.equal(download.status,200);assert.deepEqual(Buffer.from(await download.arrayBuffer()),plain);assert.equal(download.headers.get('cache-control'),'private, no-store');assert.equal(f.streamCalls(),1);
 assert.deepEqual((await(await f.call('b','files')).json()).files,[]);assert.equal((await(await f.call('c','messages?peer=a')).json()).messages.length,0);
 assert.equal((await f.call('a','messages/'+message.id+'/recall',{},'recall')).status,200);assert.equal((await f.call('b','private-attachments/'+grant.id+'/file')).status,404);
 f.revoke();assert.equal((await f.call('a','private-attachments/'+grant.id)).status,403);
});
test('private voice preserves duration and its file stream rejects tampered encrypted bytes',async t=>{
 const f=await fixture(t),{grant,message}=await f.upload(Buffer.from('voice test only'),'voice');assert.equal(message.attachments[0].duration_ms,3000);
 f.corrupt();await assert.rejects(async()=>{const r=await f.call('b','private-attachments/'+grant.id+'/file');await r.arrayBuffer();});
});
test('large encrypted upload reads deterministic bounded parts across tag boundaries',async()=>{
 const file=new Blob([Buffer.alloc(18*1024*1024+11,19)]),grant={id:'test',size:file.size,key_base64:Buffer.alloc(32,7).toString('base64'),iv_prefix:Buffer.alloc(8,9).toString('base64')};
 const source=await encryptedSource(file,grant),first=Buffer.from(await(await source.readPart(0,16*1024*1024)).arrayBuffer()),tail=Buffer.from(await(await source.readPart(16*1024*1024,source.size)).arrayBuffer());
 const overlap=Buffer.from(await(await source.readPart(16*1024*1024-19,16*1024*1024+25)).arrayBuffer());assert.deepEqual(overlap,Buffer.concat([first.subarray(first.length-19),tail.subarray(0,25)]));
 await assert.rejects(source.readPart(0,17*1024*1024));
});

import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {createServer} from 'node:http';
import {createRuntimeHandler} from '../server/business/runtime.mjs';
import {nativeBusinessSession,PROJECT} from '../server/business/native-authority.mjs';
import {memberDeviceCookie} from '../server/native-member-login.mjs';
test('real HTTP chat writes, reads and SSE heartbeats reuse one identity check per device without mixing authors',async t=>{
 const counts={identity:0,directory:0},actors=['a','b'],cookies=actors.map(a=>memberDeviceCookie('synthetic-device-'+a)),db=new DatabaseSync(':memory:');
 const fetcher=async(url,o)=>{const token=o.headers.authorization?.replace('Bearer ','');const actor=actors.find(a=>token==='synthetic-device-'+a);assert.ok(actor,'request must use this device credential');
  if(url.endsWith('/v2/me')){counts.identity++;return Response.json({actor_id:actor,member_label:actor,principal_kind:'member',until_revoked:true,expires_at:null});}
  if(url.endsWith('/v2/projects/members')){counts.directory++;return Response.json({project_id:PROJECT,members:actors.map(actor_id=>({actor_id,can_read:true,can_write:true})),next_offset:null});}
  throw Error('unexpected upstream '+url);
 };
 let clock=Date.now();t.mock.method(Date,'now',()=>clock);
 const handler=createRuntimeHandler(db,{sessionFactory:cookie=>nativeBusinessSession(cookie,null,{fetcher}),eventsOptions:{heartbeatMs:10}}),server=createServer(handler);
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{handler.close();server.closeAllConnections();server.close();db.close();});
 const base='http://127.0.0.1:'+server.address().port;
 const stream=await fetch(base+'/business/v1/events',{headers:{cookie:cookies[1]}});assert.equal(stream.status,200);const reader=stream.body.getReader();await reader.read();
 for(let n=0;n<30;n++){
  const sender=n%2,r=await fetch(base+'/business/v1/messages',{method:'POST',headers:{cookie:cookies[sender],origin:'https://local.invalid','content-type':'application/json','idempotency-key':'message-'+n},body:JSON.stringify({body:'message '+n,attachment_ids:[],mention_usernames:[]})});
  assert.equal(r.status,201);assert.equal((await r.json()).message.author_username,actors[sender]);
  const read=await fetch(base+'/business/v1/messages',{headers:{cookie:cookies[1-sender]}});assert.equal(read.status,200);await read.json();
 }
 await new Promise(r=>setTimeout(r,50));await reader.cancel();
 assert.deepEqual(counts,{identity:2,directory:2},'30 sends, 30 reads and heartbeats must not run per-message identity or directory reads');
 // Cross the actual 60-second authority cache boundary. Heartbeats must stay
 // local even after expiry; the next business request must verify afresh.
 clock+=61000;
 await new Promise(r=>setTimeout(r,50));
 assert.deepEqual(counts,{identity:2,directory:2},'expired cache alone must not trigger idle identity polling');
 const checked=await fetch(base+'/business/v1/bootstrap',{headers:{cookie:cookies[1]}});assert.equal(checked.status,200);assert.equal((await checked.json()).actor_id,'b');
 assert.deepEqual(counts,{identity:3,directory:3},'a real data request still verifies expired authority');
 handler.invalidateSession(cookies[0]);const restored=await fetch(base+'/business/v1/bootstrap',{headers:{cookie:cookies[0]}});assert.equal(restored.status,200);assert.equal((await restored.json()).actor_id,'a');assert.deepEqual(counts,{identity:4,directory:4});
});

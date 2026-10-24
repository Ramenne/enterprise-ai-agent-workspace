import test from 'node:test';import assert from 'node:assert/strict';
import {createGateway} from '../server/gateway.mjs';
function fixture(){let sessions=0;const origin='https://app.example.com';
 const fetcher=async url=>{
  if(url.endsWith('/get-session')){sessions++;return new Response(JSON.stringify({session:{token:'synthetic-session-placeholder',expiresAt:new Date(Date.now()+28800000).toISOString()}}),{headers:{'content-type':'application/json','set-cookie':'test-session=synthetic; Domain=service.example.invalid; Path=/hub2-preview; HttpOnly; Secure; Max-Age=28800; SameSite=Lax'}});}
  return new Response(JSON.stringify(url.endsWith('/api/me')?{identity:{actor_id:'synthetic-member'}}:{state:'read',items:[]}),{headers:{'content-type':'application/json'}});
 };return {server:createGateway({publicOrigin:origin,nativeOrigins:['https://localhost'],fetcher}),origin,sessions:()=>sessions};}
test('native identity read returns renewed host-only cookie without exposing the bearer',async t=>{
 const f=fixture();await new Promise(r=>f.server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>f.server.close(r)));
 const r=await fetch('http://127.0.0.1:'+f.server.address().port+'/native/session',{headers:{cookie:'test-session=synthetic',origin:'https://localhost'}});
 assert.equal(r.status,200);assert.equal(f.sessions(),1);const cookies=r.headers.getSetCookie();assert.equal(cookies.length,1);
 assert.match(cookies[0],/Max-Age=28800/);assert.match(cookies[0],/Path=\/; HttpOnly; Secure; SameSite=None/);assert.ok(!cookies[0].includes('Domain='));
 const value=await r.json();assert.deepEqual(value,{identity:{actor_id:'synthetic-member'}});assert.ok(!JSON.stringify(value).includes('synthetic-session-placeholder'));
});
test('ordinary RPC also forwards native renewal instead of updating only the upstream database',async t=>{
 const f=fixture();await new Promise(r=>f.server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>f.server.close(r)));
 const r=await fetch('http://127.0.0.1:'+f.server.address().port+'/native/rpc',{method:'POST',headers:{cookie:'test-session=synthetic',origin:f.origin,'content-type':'application/json'},body:JSON.stringify({name:'mem.search',arguments:{project_id:'synthetic-project'}})});
 assert.equal(r.status,200);assert.equal(r.headers.getSetCookie().length,1);assert.match(r.headers.getSetCookie()[0],/SameSite=Lax/);
});

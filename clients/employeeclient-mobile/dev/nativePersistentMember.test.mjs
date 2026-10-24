import test from 'node:test';import assert from 'node:assert/strict';
import {persistNativeMember,resolveNativeMember,revokeNativeMember,memberDeviceCookie} from '../server/native-member-login.mjs';
import {createGateway} from '../server/gateway.mjs';
const ephemeral='synthetic-web-member-only',persistent='synthetic-persistent-member-only',actor='synthetic-A',credential_id='cfe3f0af-af84-4c63-a0d6-2d0677caaddd';
const identity={actor_id:actor,principal_kind:'member',authorization_mode:'member_qualification',credential_id,until_revoked:true,expires_at:null};
const key='qn-device-8662ae87-2e86-405e-aa76-c2b6e807b0b1';
function fixture(){const calls=[];let revoked=false;return {calls,fetcher:async(url,opts)=>{calls.push({url,opts});let v;
 if(url.endsWith('/get-session'))v={session:{token:ephemeral,expiresAt:new Date(Date.now()+60000).toISOString()},user:{name:'A'}};
 else if(url.endsWith('/credentials/create')){assert.equal(opts.headers.authorization,'Bearer '+ephemeral);const b=JSON.parse(opts.body);assert.equal(b.until_revoked,true);assert.equal(b.expires_at,null);assert.deepEqual(b.resource_selector,{version:1,kind:'projects',project_ids:['ad44cc0e-159e-4e0f-a5ca-73d3920240d9']});assert.ok(!('actor_id' in b));v={credential:persistent,credential_id};}
 else if(url.endsWith('/credentials/revoke')){assert.equal(JSON.parse(opts.body).credential_id,credential_id);revoked=true;v={state:'revoked'};}
 else if(url.endsWith('/v2/me')){if(revoked&&opts.headers.authorization==='Bearer '+persistent)return new Response(JSON.stringify({error_code:'revoked'}),{status:401});v=identity;}
 else throw Error('unexpected route');return new Response(JSON.stringify(v),{headers:{'content-type':'application/json'}});}};}
test('device credential is created under the signed-in member and survives absence of webpage cookie',async()=>{
 const f=fixture(),member=await persistNativeMember('synthetic-cookie',key,f);assert.equal(member.identity.actor_id,actor);
 const restored=await resolveNativeMember(memberDeviceCookie(member.token),f);assert.equal(restored.persistent,true);assert.equal(restored.identity.actor_id,actor);
 assert.equal(f.calls.filter(c=>c.url.endsWith('/get-session')).length,1);
});
test('revoked persistent identity never falls back to the still-valid web session',async()=>{
 const f=fixture(),cookie=memberDeviceCookie(persistent)+'; hub2_preview.session_token=synthetic';await revokeNativeMember(cookie,f);
 await assert.rejects(resolveNativeMember(cookie,f),e=>e.status===401);assert.ok(!f.calls.some(c=>c.url.endsWith('/get-session')));
});
test('product service identity cannot be installed as a member login',async()=>{
 await assert.rejects(resolveNativeMember(memberDeviceCookie(persistent),{fetcher:async()=>new Response(JSON.stringify({...identity,principal_kind:'service',authorization_mode:'product_service'}))}),e=>e.status===403);
});
test('new credential whose actor differs from the authenticated member is rejected',async()=>{
 const f=fixture(),base=f.fetcher;f.fetcher=async(url,opts)=>url.endsWith('/v2/me')&&opts.headers.authorization==='Bearer '+persistent?new Response(JSON.stringify({...identity,actor_id:'other-member'})):base(url,opts);
 await assert.rejects(persistNativeMember('synthetic-cookie',key,f),e=>e.code==='member_device_identity_mismatch');
});
test('gateway returns only public identity and clears persistent and legacy login cookies on logout',async t=>{
 const f=fixture(),origin='https://app.example',server=createGateway({...f,publicOrigin:origin,persistentLoginEnabled:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port;
 const r=await fetch(base+'/native/persist-session',{method:'POST',headers:{origin,cookie:'hub2_preview.session_token=synthetic','idempotency-key':key},body:'{}'});assert.equal(r.status,200);assert.ok(!JSON.stringify(await r.json()).includes(persistent));const cookie=r.headers.getSetCookie().find(c=>c.startsWith('qn_member_device='));assert.match(cookie,/HttpOnly; Secure; SameSite=Lax; Max-Age=34560000/);
 const out=await fetch(base+'/native/sign-out',{method:'POST',headers:{origin,cookie:cookie.split(';')[0]+'; hub2_preview.session_token=synthetic'},body:'{}'});assert.equal(out.status,200);assert.equal(out.headers.getSetCookie().length,2);assert.ok(out.headers.getSetCookie().every(c=>c.endsWith('Max-Age=0')));
});
test('persistent credential creation stays disabled until real acceptance is authorized',async t=>{
 let calls=0;const server=createGateway({publicOrigin:'https://app.example',fetcher:async()=>{calls++;throw Error('must not execute');}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const r=await fetch('http://127.0.0.1:'+server.address().port+'/native/persist-session',{method:'POST',headers:{origin:'https://app.example','idempotency-key':key},body:'{}'});assert.equal(r.status,503);assert.equal(calls,0);
});
test('logged-out session with no cookie is anonymous without contacting the upstream',async()=>{let calls=0;await assert.rejects(resolveNativeMember(undefined,{fetcher:async()=>{calls++;throw Error('unexpected');}}),e=>e.status===401);assert.equal(calls,0);});
test('an empty official web session is anonymous instead of a recovery failure',async()=>{await assert.rejects(resolveNativeMember('synthetic-cookie',{fetcher:async()=>new Response('null')}),e=>e.status===401);});

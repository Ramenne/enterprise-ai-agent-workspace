import test from 'node:test';
import assert from 'node:assert/strict';
import {businessRequest} from '../src/native/business-transport.mjs';
test('business writes use native cookie and stable idempotency without old token',async()=>{
 let options,url;
 await businessRequest('https://app.example.com','POST','/business/v1/messages',{lease:{valid:()=>true},key:'original',body:{body:'hello'},fetcher:async(u,o)=>{url=u;options=o;return Response.json({state:'published'})}});
 assert.equal(url,'https://app.example.com/business/v1/messages');assert.equal(options.credentials,'include');
 assert.equal(options.headers.Authorization,undefined);assert.equal(options.headers['idempotency-key'],'original');
});
test('retired paths and changed identity cannot reach or accept a business response',async()=>{
 let calls=0,valid=true,finish;
 const fetcher=()=>{calls++;return new Promise(resolve=>{finish=resolve})};
 await assert.rejects(businessRequest('https://app.example.com','GET','/api/v2/me/tasks',{lease:{valid:()=>true},fetcher}),e=>e.code==='retired_or_unknown_business_route');
 assert.equal(calls,0);
 const delayed=businessRequest('https://app.example.com','GET','/business/v1/messages',{lease:{valid:()=>valid},fetcher});
 valid=false;finish(Response.json({messages:[{body:'other account'}]}));
 await assert.rejects(delayed,e=>e.code==='session_changed');
});
test('the exact own-avatar write is reachable without enabling arbitrary profile routes',async()=>{
 let calls=0;const opts={lease:{valid:()=>true},key:'avatar-key',body:{mime:'image/jpeg',bytes_base64:'test'},fetcher:async()=>{calls++;return Response.json({avatar_version:'v'});}};
 await businessRequest('https://app.example.com','POST','/business/v1/profile/avatar',opts);assert.equal(calls,1);
 await assert.rejects(businessRequest('https://app.example.com','POST','/business/v1/profile/roles',opts),e=>e.code==='retired_or_unknown_business_route');assert.equal(calls,1);
});
test('request timeout is a retryable transport condition, distinct from explicit cancellation',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});t.after(()=>t.mock.timers.reset());
 const fetcher=(_url,opts)=>new Promise((_resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(opts.signal.reason),{once:true}));
 const result=businessRequest('https://app.example.com','GET','/business/v1/messages',{lease:{valid:()=>true},timeout:50,fetcher}),failed=assert.rejects(result,e=>e.code==='business_transport_timeout'&&e.status===0);t.mock.timers.tick(50);await failed;
 const ctl=new AbortController(),cancelled=businessRequest('https://app.example.com','GET','/business/v1/messages',{lease:{valid:()=>true},timeout:50,fetcher,signal:ctl.signal});ctl.abort();await assert.rejects(cancelled,e=>e.name==='AbortError');
});
test('timer abort while decoding JSON remains transport timeout and never forces reauthentication',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});t.after(()=>t.mock.timers.reset());let auth=0;
 const result=businessRequest('https://app.example.com','GET','/business/v1/messages',{lease:{valid:()=>true},timeout:50,onUnauthorized:()=>auth++,fetcher:async(_url,opts)=>({ok:true,status:200,json:()=>new Promise((_resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(opts.signal.reason),{once:true}))})});
 const failed=assert.rejects(result,e=>e.code==='business_transport_timeout');await Promise.resolve();t.mock.timers.tick(50);await failed;assert.equal(auth,0);
});

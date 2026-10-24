import test from 'node:test';import assert from 'node:assert/strict';
import {createGateway} from '../server/gateway.mjs';
import {request as httpRequest} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
const project='cfe3f0af-af84-4c63-a0d6-2d0677caaddd',operation='8662ae87-2e86-405e-aa76-c2b6e807b0b1';
const json=(v,status=200)=>new Response(JSON.stringify(v),{status});
test('relay checks own current Mem operation and forwards bounded exact bytes without caller URL or session token',async t=>{
 const calls=[],server=createGateway({publicOrigin:'https://app.test',fetcher:async(url,opts)=>{
  calls.push({url,opts});
  if(url.endsWith('/get-session'))return json({session:{token:'fixture-session',expiresAt:new Date(Date.now()+60000).toISOString()}});
  if(url.endsWith('/put-ticket')){assert.deepEqual(JSON.parse(opts.body),{project_id:project});return json({state:'uploading',size:3,ticket:{method:'PUT',url:'https://provider.test/object',required_headers:{'x-fixture':'metadata'}}});}
  assert.equal(url,'https://provider.test/object');assert.equal(opts.headers.authorization,undefined);assert.equal(opts.headers.cookie,undefined);
  const chunks=[];for await(const b of opts.body)chunks.push(b);assert.equal(Buffer.concat(chunks).toString(),'abc');return new Response('');
 }});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const base='http://127.0.0.1:'+server.address().port;
 const path='/native/upload?'+new URLSearchParams({project_id:project,operation_id:operation,size:'3'});
 const headers={origin:'https://app.test',cookie:'fixture-cookie'};
 let response=await fetch(base+path,{method:'POST',headers,body:'abc'});assert.equal(response.status,200);assert.deepEqual(await response.json(),{state:'staged',operation_id:operation,size:3});
 const before=calls.length;
 response=await fetch(base+path+'&url=https://attacker.test',{method:'POST',headers,body:'abc'});assert.equal(response.status,400);assert.equal(calls.length,before);
 response=await fetch(base+path,{method:'POST',headers:{...headers,origin:'https://foreign.test'},body:'abc'});assert.equal(response.status,403);assert.equal(calls.length,before);
 response=await fetch(base+path,{method:'POST',headers,body:'abcd'});assert.equal(response.status,400);assert.equal(calls.length,before);
});
test('a denied Mem ticket stops before any provider transfer',async t=>{
 let provider=0;const server=createGateway({publicOrigin:'https://app.test',fetcher:async(url)=>{
  if(url.endsWith('/get-session'))return json({session:{token:'fixture',expiresAt:new Date(Date.now()+60000).toISOString()}});
  if(url.includes('/hub2-preview/mem/'))return json({state:'failed',error_code:'forbidden'},403);
  provider++;return new Response('');
 }});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const response=await fetch('http://127.0.0.1:'+server.address().port+'/native/upload?'+new URLSearchParams({project_id:project,operation_id:operation,size:'3'}),{method:'POST',headers:{origin:'https://app.test',cookie:'fixture-cookie'},body:'abc'});
 assert.equal(response.status,403);assert.equal((await response.json()).error_code,'forbidden');assert.equal(provider,0);
});

test('actual HTTP disconnect after all bytes aborts provider while awaiting its reply',async t=>{
 let started,providerSignal,finish;const ready=new Promise(r=>started=r);
 const server=createGateway({publicOrigin:'https://app.test',fetcher:async(url,opts)=>{
  if(url.endsWith('/get-session'))return json({session:{token:'fixture',expiresAt:new Date(Date.now()+60000).toISOString()}});
  if(url.endsWith('/put-ticket'))return json({state:'uploading',size:3,ticket:{method:'PUT',url:'https://provider.test/object'}});
  providerSignal=opts.signal;for await(const _ of opts.body){}started();return new Promise(r=>finish=r);
 }});assert.equal(server.requestTimeout,1800000);assert.equal(server.headersTimeout,60000);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
 const req=httpRequest('http://127.0.0.1:'+server.address().port+'/native/upload?'+new URLSearchParams({project_id:project,operation_id:operation,size:'3'}),{method:'POST',headers:{origin:'https://app.test',cookie:'fixture','content-length':'3'}});req.on('error',()=>{});req.end('abc');await ready;req.destroy();
 for(let i=0;i<30&&!providerSignal.aborted;i++)await delay(10);assert.equal(providerSignal.aborted,true);finish(new Response(''));
});

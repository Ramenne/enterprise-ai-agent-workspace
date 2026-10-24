import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createNativeIngress} from '../server/native-ingress.mjs';
async function start(server){server.listen(0,'127.0.0.1');await once(server,'listening');return 'http://127.0.0.1:'+server.address().port;}
const stop=s=>new Promise(r=>s.close(r));
test('native directory enumeration follows the current member session and exact public route',async()=>{
 const seen=[];const ingress=createNativeIngress({publicOrigin:'https://employeeclient.example.invalid/',fetcher:async(url,opts)=>{
  seen.push({url,path:new URL(url).pathname,body:opts.body?JSON.parse(opts.body):null,authorization:opts.headers.authorization});
  return new Response(JSON.stringify(url.endsWith('/get-session')?{session:{token:'simulation-only-member',expiresAt:new Date(Date.now()+60000).toISOString()}}:{items:[],next_cursor:null}),{headers:{'content-type':'application/json'}});
 }}),base=await start(ingress);
 try{const r=await fetch(base+'/native/rpc',{method:'POST',headers:{origin:'https://employeeclient.example.invalid/','content-type':'application/json',cookie:'local-simulation=1'},body:JSON.stringify({name:'mem.enumerate.page',arguments:{project_id:'p',snapshot_id:'s',cursor:0,limit:100}})});assert.equal(r.status,200);assert.equal(seen.length,2);assert.equal(seen[1].path,'/hub2-preview/mem/v2/material-enumerations/page');assert.equal(seen[1].authorization,'Bearer simulation-only-member');assert.equal((await r.json()).next_cursor,null);assert.deepEqual(seen[1].body,{project_id:'p',snapshot_id:'s',cursor:0,limit:100});}finally{await stop(ingress);}
});
test('business proxy preserves the actual cookie and streaming message without opening another worker',async()=>{
 let clientClosed=false;const backend=createServer((req,res)=>{
  assert.equal(req.headers.cookie,'local-simulation=1');
  if(req.url==='/health'){res.writeHead(200,{'content-type':'application/json'});res.end('{"chat":"runtime_connected"}');return;}
  res.writeHead(200,{'content-type':'text/event-stream','set-cookie':'local-simulation=renewed; HttpOnly; Path=/'});res.write('data: first\n\n');
  res.once('close',()=>{clientClosed=true;});
 });const backendOrigin=await start(backend),ingress=createNativeIngress({backendOrigin,publicOrigin:'https://employeeclient.example.invalid/'}),base=await start(ingress);
 try{const health=await fetch(base+'/health',{headers:{cookie:'local-simulation=1'}});assert.equal((await health.json()).chat,'runtime_connected');const ctl=new AbortController(),r=await fetch(base+'/business/v1/events',{headers:{origin:'https://employeeclient.example.invalid/',cookie:'local-simulation=1'},signal:ctl.signal});assert.equal(r.headers.get('set-cookie'),'local-simulation=renewed; HttpOnly; Path=/');assert.equal(new TextDecoder().decode((await r.body.getReader().read()).value),'data: first\n\n');ctl.abort();await new Promise(r=>setTimeout(r,20));assert.equal(clientClosed,true);assert.equal(backend.listening,true);}finally{ingress.closeAllConnections();backend.closeAllConnections();await stop(ingress);await stop(backend);}
});
test('unknown caller-selected hosts and spoofed actor arguments are rejected',async()=>{
 assert.throws(()=>createNativeIngress({backendOrigin:'https://outside.invalid'}),/loopback/);
 const ingress=createNativeIngress({publicOrigin:'https://employeeclient.example.invalid/',fetcher:()=>{throw Error('must not use upstream');}}),base=await start(ingress);
 try{const r=await fetch(base+'/native/rpc',{method:'POST',headers:{origin:'https://employeeclient.example.invalid/','content-type':'application/json'},body:JSON.stringify({name:'mem.enumerate',arguments:{actor_id:'other',project_id:'p'}})});assert.equal(r.status,400);assert.equal((await r.json()).error_code,'invalid_native_arguments');}finally{await stop(ingress);}
});

test('voice start has a bounded model response budget instead of a short connection budget',async()=>{
 const backend=createServer((_req,res)=>{setTimeout(()=>{res.writeHead(200,{'content-type':'application/json'});res.end('{"state":"completed"}');},80);}),backendOrigin=await start(backend);
 const ingress=createNativeIngress({backendOrigin,publicOrigin:'https://test.invalid',connectTimeoutMs:30,responseTimeoutMs:30,asrTimeoutMs:200}),base=await start(ingress);
 try{const response=await fetch(base+'/business/v1/voice-asr/start',{method:'POST',headers:{origin:'https://test.invalid','content-type':'application/json','idempotency-key':'test'},body:'{}'});assert.equal(response.status,200);assert.equal((await response.json()).state,'completed');
 const normal=await fetch(base+'/business/v1/messages');assert.equal(normal.status,503);
 }finally{ingress.closeAllConnections();backend.closeAllConnections();await stop(ingress);await stop(backend);}
});

test('public ingress signs and consumes the member device credential without depending on web-session lifetime',async()=>{
 const token='synthetic-ingress-permanent-member',identity={actor_id:'member-A',principal_kind:'member',authorization_mode:'member_qualification',credential_id:'credential-A',until_revoked:true,expires_at:null};let revoked=false,legacyReads=0;
 const ingress=createNativeIngress({publicOrigin:'https://app.test',persistentLoginEnabled:true,fetcher:async(url,opts)=>{
  if(url.endsWith('/get-session')){legacyReads++;return Response.json({session:{token:'synthetic-web',expiresAt:new Date(Date.now()+60000).toISOString()}});}
  if(url.endsWith('/credentials/create'))return Response.json({credential:token,credential_id:identity.credential_id});
  if(url.endsWith('/v2/me')){if(revoked)return Response.json({error_code:'revoked'},{status:401});assert.ok(['Bearer synthetic-web','Bearer '+token].includes(opts.headers.authorization));return Response.json(identity);}
  if(url.endsWith('/api/me'))return Response.json({identity:{actor_id:'member-A'}});
  if(url.endsWith('/material-enumerations/page')){assert.equal(opts.headers.authorization,'Bearer '+token);return Response.json({items:[],next_cursor:null});}
  throw Error('Unexpected auth path');
 }}),base=await start(ingress);
 try{
  const first=await fetch(base+'/native/session',{headers:{cookie:'legacy=fixture'}});assert.equal((await first.json()).persistent_login_available,true);
  const signed=await fetch(base+'/native/persist-session',{method:'POST',headers:{origin:'https://app.test',cookie:'legacy=fixture','idempotency-key':'qn-device-8662ae87-2e86-405e-aa76-c2b6e807b0b1'},body:'{}'});assert.equal(signed.status,200);
  const cookie=signed.headers.getSetCookie().find(x=>x.startsWith('qn_member_device=')).split(';')[0],before=legacyReads;
  const restored=await fetch(base+'/native/session',{headers:{cookie}});assert.equal((await restored.json()).persistent_login,true);assert.equal(legacyReads,before);
  const rpc=await fetch(base+'/native/rpc',{method:'POST',headers:{cookie,origin:'https://app.test','content-type':'application/json'},body:JSON.stringify({name:'mem.enumerate.page',arguments:{project_id:'p',snapshot_id:'s',cursor:0,limit:100}})});assert.equal(rpc.status,200);assert.equal(legacyReads,before);
  revoked=true;assert.equal((await fetch(base+'/native/session',{headers:{cookie:cookie+'; legacy=fixture'}})).status,401);assert.equal(legacyReads,before);
 }finally{await stop(ingress);}
});
test('single-submit media waits for its bounded backend receipt while ordinary queries retain the short budget',async()=>{
 const backend=createServer((req,res)=>{req.resume();req.on('end',()=>setTimeout(()=>{res.writeHead(200,{'content-type':'application/json'});res.end('{"state":"published"}');},80));}),backendOrigin=await start(backend);
 const ingress=createNativeIngress({backendOrigin,publicOrigin:'https://test.invalid',responseTimeoutMs:30,mediaTimeoutMs:200}),base=await start(ingress);
 try{const media=await fetch(base+'/business/v1/media-transfers',{method:'POST',headers:{origin:'https://test.invalid','content-type':'application/octet-stream','idempotency-key':'original-media-key'},body:'local-simulation'});assert.equal(media.status,200);assert.equal((await media.json()).state,'published');const normal=await fetch(base+'/business/v1/messages');assert.equal(normal.status,503);}finally{ingress.closeAllConnections();backend.closeAllConnections();await stop(ingress);await stop(backend);}
});

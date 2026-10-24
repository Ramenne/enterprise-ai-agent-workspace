import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeClient,sha256} from '../src/native/client.mjs';
import {createGateway,relayCookie,nativeRoute} from '../server/gateway.mjs';
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
test('retired mobile permission entry is absent while member work and file routes remain',()=>{
  assert.equal(nativeRoute('hufu.access.prepare',{project:'员工客户端',profile:'business'}),null);
  assert.equal(nativeRoute('hufu.access.apply',{actor_id:'another',profile:'business'}),null);
  assert.equal(nativeRoute('hufu.access.applications',{view:'managed'}),null);
  assert.equal(nativeRoute('hufu.access.apply',{profile:'vault'}),null);
  assert.equal(nativeRoute('hufu.access.decide',{}),null);
});
test('retired permission submission is rejected before any identity or network forwarding',async t=>{
  let called=0;const server=createGateway({publicOrigin:'https://app.example.com',fetcher:async()=>{called++;return json({});}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/native/rpc',{method:'POST',headers:{origin:'https://app.example.com','content-type':'application/json'},body:JSON.stringify({name:'hufu.access.apply',arguments:{project:'员工客户端',profile:'business'}})});
  assert.equal(response.status,400);assert.equal(called,0);
});
test('native sign-in uses OTP and HttpOnly cookie transport, never Authorization',async()=>{
  const calls=[];
  const client=new NativeClient({fetcher:async(url,opts)=>{calls.push({url,opts});return json(url.endsWith('/session')?{identity:{actor_id:'actor-a'},cache_partition:'scope-a'}:{state:'signed_in'});}});
  await client.signIn('member@example.com','000000');
  assert.deepEqual(JSON.parse(calls[0].opts.body),{email:'member@example.com',otp:'000000'});
  assert.equal(calls[0].opts.credentials,'include');assert.equal(calls[0].opts.headers.Authorization,undefined);
  assert.equal(client.partition,'"scope-a"');
});
test('delayed result from old session is discarded',async()=>{
  let deliver;const client=new NativeClient({fetcher:()=>new Promise(r=>deliver=r)});
  const pending=client.files('project-a');client.reset();deliver(json({items:[{material_id:'private-a'}]}));
  await assert.rejects(pending,e=>e.code==='session_changed');
});
test('project pagination handles all pages and refuses a repeated cursor',async()=>{
  let index=0;const pages=[{items:[{project_id:'a'}],next_cursor:'b'},{items:[{project_id:'b'}],next_cursor:null}];
  const client=new NativeClient({fetcher:async()=>json(pages[index++])});assert.equal((await client.projects()).length,2);
  const repeated=new NativeClient({fetcher:async()=>json({items:[],next_cursor:'same'})});
  await assert.rejects(repeated.projects(),e=>e.code==='pagination_stalled');
});
test('fixed downloads verify every range and whole hash before Blob delivery',async()=>{
  const bytes=new TextEncoder().encode('actual fixed bytes'),hash=await sha256(bytes);
  const fixed={material_id:'material-a',version_id:'version-a',size:bytes.length,sha256:hash};
  const client=new NativeClient({fetcher:async()=>json({fixed_ref:fixed,bytes_base64:Buffer.from(bytes).toString('base64'),chunk_sha256:hash,range:{start:0,end_exclusive:bytes.length},next_offset:null})});
  assert.equal(await (await client.readFile('project-a',fixed)).text(),'actual fixed bytes');
  const invalid=new NativeClient({fetcher:async()=>json({fixed_ref:fixed,bytes_base64:Buffer.from(bytes).toString('base64'),chunk_sha256:hash,range:{start:1,end_exclusive:bytes.length+1}})});
  await assert.rejects(invalid.readFile('project-a',fixed),e=>e.code==='invalid_read_range');
});
test('native upload uses same-origin member bytes without exposing ticket; publication required',async()=>{
  const file=new Blob(['sample']),hash=await sha256(new Uint8Array(await file.arrayBuffer()));
  let put,tools=[];
  const client=new NativeClient({fetcher:async(url,opts)=>{
    if(url.includes('/native/upload?')){put=opts;assert.ok(!url.includes('staging.example'));return json({state:'staged',operation_id:'operation',size:file.size});}
    const {name}=JSON.parse(opts.body);tools.push(name);
    return json(name==='mem.upload.put_status'?{state:'uploading'}:name==='mem.upload.ticket'?{state:'uploading',size:file.size,ticket:{method:'PUT',url:'https://staging.example.invalid/object',required_headers:{'content-length':String(file.size),'x-amz-meta-hub-operation-id':'operation'}}}:name==='mem.upload.publish'?{state:'published',fixed_refs:[{sha256:hash,size:file.size}]}:{state:'completed'});
  }});
  await client.finishUpload({project_id:'project',operation_id:'operation',sha256:hash,size:file.size},file);
  assert.equal(put.credentials,'include');assert.equal(put.method,'POST');assert.equal(put.headers,undefined);
  assert.deepEqual(tools,['mem.upload.put_status','mem.upload.ticket','mem.upload.put_complete','mem.upload.publish']);
});
test('gateway rejects foreign origins, old endpoints and management tools',async(t)=>{
  let forwarded=[];
  const server=createGateway({publicOrigin:'https://app.example.com',fetcher:async(url,opts)=>{forwarded.push({url,opts});return json(url.endsWith('/get-session')?{session:{token:'synthetic-native-session-not-a-secret',expiresAt:new Date(Date.now()+60000).toISOString()}}:{state:'read',items:[]});}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const base='http://127.0.0.1:'+server.address().port;
  assert.equal((await fetch(base+'/native/rpc',{method:'POST',headers:{origin:'https://evil.example','content-type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch(base+'/native/rpc',{method:'POST',headers:{origin:'https://app.example.com','content-type':'application/json'},body:JSON.stringify({name:'hufu.qualification.grant',arguments:{}})})).status,400);
  assert.equal((await fetch(base+'/native/old-login',{method:'POST',headers:{origin:'https://app.example.com'}})).status,404);
  assert.equal(forwarded.length,0);
  assert.equal((await fetch(base+'/native/rpc',{method:'POST',headers:{origin:'https://app.example.com','content-type':'application/json',cookie:'synthetic-member-cookie'},body:JSON.stringify({name:'mem.search',arguments:{project_id:'project'}})})).status,200);
  assert.ok(forwarded[0].url.endsWith('/v2/auth/get-session'));
  assert.equal(forwarded[1].url,'https://hufu.example.invalid/hub2-preview/mem/v2/materials/search');
  assert.equal(forwarded[1].opts.headers.cookie,undefined);
});
test('native route fixes operation in path and cannot select another actor',()=>{
  assert.deepEqual(nativeRoute('mem.upload.publish',{project_id:'p',operation_id:'cfe3f0af-af84-4c63-a0d6-2d0677caaddd'}),{path:'/hub2-preview/mem/v2/uploads/cfe3f0af-af84-4c63-a0d6-2d0677caaddd/publish',body:{project_id:'p'}});
  assert.equal(nativeRoute('mem.material.head',{project_id:'p',actor_id:'other'}),null);
  assert.equal(nativeRoute('mem.upload.ticket',{operation_id:'../../credentials'}),null);
});
test('native cookie remains host-only, HttpOnly and secure',()=>{
  const result=relayCookie('test-session=synthetic; Path=/hub2-preview; Domain=service.example.invalid; SameSite=Lax; HttpOnly; Secure',{crossSite:true});
  assert.ok(!result.includes('Domain='));assert.ok(result.endsWith('Path=/; HttpOnly; Secure; SameSite=None'));
});
test('a fresh upload initializes PUT mode; unrelated ambiguous errors stop before PUT',async()=>{
  const file=new Blob([]),hash=await sha256(new Uint8Array());let put=0;
  const client=new NativeClient({fetcher:async(url,opts)=>{
    if(url.includes('/native/upload?')){put++;return json({state:'staged',operation_id:'original',size:0});}
    const {name}=JSON.parse(opts.body);
    return json(name==='mem.upload.put_status'?{state:'failed',error_code:'upload_mode_conflict'}:name==='mem.upload.ticket'?{state:'uploading',size:0,ticket:{url:'https://staging.example.invalid/object',method:'PUT',required_headers:{}}}:name==='mem.upload.publish'?{state:'published',fixed_refs:[{sha256:hash,size:0}]}:{state:'completed'});
  }});
  await client.finishUpload({project_id:'project',operation_id:'original',sha256:hash,size:0},file);assert.equal(put,1);
  const uncertain=new NativeClient({fetcher:async()=>json({state:'failed',error_code:'upstream_unavailable'})});
  await assert.rejects(uncertain.finishUpload({project_id:'project',operation_id:'original',sha256:hash,size:0},file),e=>e.code==='upstream_unavailable');
});
test('default browser transport keeps the global receiver',async()=>{
 const old=globalThis.fetch;
 globalThis.fetch=function(){assert.equal(this,globalThis);return Promise.resolve(json({identity:{actor_id:'member'}}));};
 try{const client=new NativeClient();const result=await client.session();assert.equal(result.identity.actor_id,'member');}
 finally{globalThis.fetch=old;}
});
test('anonymous session miss does not revoke a nonexistent session',async()=>{
 let invalidations=0;
 const client=new NativeClient({fetcher:async()=>new Response(JSON.stringify({error:'login_required'}),{status:401}),onUnauthorized:()=>invalidations++});
 await assert.rejects(client.session());assert.equal(invalidations,0);
 client.partition='current-member';await assert.rejects(client.session());assert.equal(invalidations,1);
});
test('reset aborts previous account requests before their late response can persist login state',async()=>{
 let release,signal;const client=new NativeClient({fetcher:async(_url,opts)=>{signal=opts.signal;return new Promise(r=>release=r);}});
 const work=client.session();client.reset();assert.equal(signal.aborted,true);release(json({identity:{actor_id:'synthetic-old'}}));await assert.rejects(work,e=>e.code==='session_changed');assert.equal(client.partition,null);
});

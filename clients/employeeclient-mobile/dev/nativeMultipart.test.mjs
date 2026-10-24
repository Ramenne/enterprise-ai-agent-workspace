import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeClient,hashFile} from '../src/native/client.mjs';
import {nativeRoute} from '../server/native-routes.mjs';
const json=(x,status=200)=>new Response(JSON.stringify(x),{status});
test('file hash is bounded and preserves the whole digest',async()=>{
 const file=new Blob([new Uint8Array(5*1024*1024)]),calls=[];const source={size:file.size,readPart:async(s,e)=>{calls.push(e-s);return file.slice(s,e);}};
 assert.equal(await hashFile(source),await hashFile(file));assert.ok(calls.every(n=>n<=4*1024*1024));assert.equal(calls.length,2);
});
test('large upload resumes existing parts and publishes only after native completion',async()=>{
 const size=70*1024*1024,hash='a'.repeat(64),tools=[],parts=[];
 const client=new NativeClient({fetcher:async(url,opts)=>{if(url.includes('/native/upload?')){parts.push(opts.body.size);assert.equal(opts.credentials,'include');return json({state:'staged',operation_id:'op',size:opts.body.size});}
 const {name}=JSON.parse(opts.body);tools.push(name);return json(name==='mem.upload.multipart.resume'?{state:'open',part_size:32*1024*1024,parts:[{part_number:1,size:32*1024*1024}]}:name==='mem.upload.multipart.part_ticket'?{state:'uploading',ticket:{method:'PUT',url:'https://fixture.invalid/part',required_headers:{}}}:name==='mem.upload.publish'?{state:'published',fixed_refs:[{sha256:hash,size}]}:{state:'completed'});}});
 const source={size,readPart:async(s,e)=>new Blob([new Uint8Array(e-s)])};
 // Whole-file validation is tested separately; here verify durable multipart
 // control and transfer ordering, including omission of already-uploaded part.
 await client.finishMultipart({project_id:'p',operation_id:'op',sha256:hash,size},source,()=>{});
 assert.deepEqual(parts,[32*1024*1024,6*1024*1024]);assert.equal(tools.at(-2),'mem.upload.multipart.complete');assert.equal(tools.at(-1),'mem.upload.publish');
});
test('multipart admission wait preserves original operation and never calls publish',async()=>{
 const tools=[];const c=new NativeClient({fetcher:async(url,opts)=>{if(url.includes('/native/upload?')){assert.equal(new URL(url,'http://local.test').searchParams.get('operation_id'),'original');return json({error_code:'upload_ticket_wait_resume_original'},503);}const {name}=JSON.parse(opts.body);tools.push(name);return json(name==='mem.upload.multipart.resume'?{state:'open',parts:[],part_size:32*1024*1024}:{state:'open'});}});
 await assert.rejects(c.finishMultipart({project_id:'p',operation_id:'original',size:70*1024*1024},{size:70*1024*1024,readPart:async(s,e)=>new Blob([new Uint8Array(e-s)])},()=>{}),e=>e.code==='upload_ticket_wait_resume_original');assert.ok(!tools.includes('mem.upload.publish'));
 const route=nativeRoute('mem.upload.multipart.part_ticket',{project_id:'p',operation_id:'cfe3f0af-af84-4c63-a0d6-2d0677caaddd',part_number:2,size:100});assert.ok(route.path.endsWith('/multipart/part-ticket'));
});

test('cancelled upload stops before publish and retains original operation for resume',async()=>{
 const file=new Blob(['cancel before publish']),hash=await hashFile(file),ctl=new AbortController(),tools=[];
 const client=new NativeClient({signal:ctl.signal,fetcher:async(url,o)=>{
  assert.ok(o.signal);if(url.includes('/native/upload?'))return json({state:'staged',operation_id:'original',size:file.size});
  const {name}=JSON.parse(o.body);tools.push(name);
  if(name==='mem.upload.put_complete'){ctl.abort();return json({state:'completed'});}
  return json(name==='mem.upload.put_status'?{state:'uploading'}:{state:'uploading',size:file.size,ticket:{method:'PUT',url:'https://fixture.invalid'}});
 }});
 await assert.rejects(client.finishUpload({project_id:'p',operation_id:'original',size:file.size,sha256:hash},file),e=>e.name==='AbortError');assert.ok(!tools.includes('mem.upload.publish'));
});
test('cancellation during byte transfer aborts the active fetch',async()=>{
 const ctl=new AbortController();let observed=false;
 const client=new NativeClient({signal:ctl.signal,fetcher:async(_url,o)=>new Promise((resolve,reject)=>{o.signal.addEventListener('abort',()=>{observed=true;reject(o.signal.reason);},{once:true});ctl.abort();})});
 await assert.rejects(client.putContent({project_id:'p',operation_id:'original'},new Blob(['bytes'])),e=>e.name==='AbortError');assert.equal(observed,true);
});

import test from 'node:test';import assert from 'node:assert/strict';import {NativeClient,hashFile} from '../src/native/client.mjs';import {uploadResponse} from '../src/native/upload-progress.mjs';
test('multipart progress resumes known parts and finishes only after publication',async()=>{
 const size=16*1024*1024,total=size*2+123,file=new Blob([new Uint8Array(total)]),digest=await hashFile(file),put=[],progress=[],steps=[];
 const operation={project_id:'p',operation_id:'o',size:total,sha256:digest};
 const client=new NativeClient({fetcher:async(url,opts)=>{const q=new URL(url).searchParams;put.push(Number(q.get('part_number')));return Response.json({state:'staged',operation_id:'o',size:opts.body.size});},base:'https://app.test'});
 client.rpc=async(name)=>{steps.push(name);if(name.endsWith('.resume'))return {state:'uploading',part_size:size,parts:[{part_number:1,size}]};if(name.endsWith('.part_ticket'))return {state:'uploading',ticket:{method:'PUT'}};if(name==='mem.upload.publish')return {state:'published',fixed_refs:[{sha256:digest,size:total}]};return {};};
 const result=await client.finishUpload(operation,file,p=>progress.push(p));assert.equal(result.state,'published');assert.deepEqual(put,[2,3]);
 assert.ok(progress.some(p=>p.phase==='hash'));const upload=progress.filter(p=>p.phase==='upload');assert.equal(upload[0].loaded,size);assert.equal(upload.at(-1).loaded,total);assert.ok(upload.every(p=>p.loaded<=p.total));assert.equal(progress.at(-1).phase,'verify');assert.equal(steps.at(-1),'mem.upload.publish');assert.ok(!steps.includes('mem.upload.multipart.part_ticket'));
});
test('browser upload uses credentialed same-origin relay and real byte events, with cancellation',async t=>{
 const original=globalThis.XMLHttpRequest,location=globalThis.location;t.after(()=>{globalThis.XMLHttpRequest=original;globalThis.location=location;});
 let instance;class XHR{constructor(){instance=this;this.upload={};}open(method,url){this.method=method;this.url=url;}send(source){this.source=source;}abort(){this.onabort();}}
 globalThis.XMLHttpRequest=XHR;globalThis.location={href:'https://app.test/chat'};
 const updates=[],ctl=new AbortController(),promise=uploadResponse('/native/upload',new Blob(['abc']),ctl.signal,n=>updates.push(n));
 assert.equal(instance.withCredentials,true);assert.equal(instance.url,'/native/upload');instance.upload.onprogress({loaded:2});assert.deepEqual(updates,[2]);
 ctl.abort();await assert.rejects(promise,e=>e.name==='AbortError');
 const done=uploadResponse('/native/upload',new Blob(['abc']),undefined,n=>updates.push(n));instance.status=200;instance.responseURL='https://app.test/native/upload';instance.responseText='{"state":"staged"}';instance.onload();assert.equal((await done).status,200);
});
test('fresh small upload avoids duplicate status and ticket; replay still checks staging status',async()=>{
 const file=new File(['tiny audio'],'audio.wav'),steps=[],client=new NativeClient(),digest=await hashFile(file);
 client.rpc=async(name)=>{steps.push(name);if(name==='mem.upload.begin')return {operation_id:'o'};if(name==='mem.upload.publish')return {state:'published',fixed_refs:[{sha256:digest,size:file.size}]};return {};};
 client.putContent=async(_op,_source,_part,progress)=>{progress(file.size);};
 const op=await client.prepareUpload('p',file,'key');await client.finishUpload(op,file);
 assert.ok(!steps.includes('mem.upload.put_status'));assert.ok(!steps.includes('mem.upload.ticket'));
 steps.length=0;await client.finishUpload(JSON.parse(JSON.stringify(op)),file);assert.equal(steps[0],'mem.upload.put_status');
});
test('slow advancing upload survives the old total limit; duplicate progress does not postpone idle timeout',async t=>{
 const original=globalThis.XMLHttpRequest;t.after(()=>{globalThis.XMLHttpRequest=original;t.mock.timers.reset()});t.mock.timers.enable({apis:['setTimeout']});
 let xhr;class XHR{constructor(){xhr=this;this.upload={};}open(){}send(){}abort(){this.onabort();}}
 globalThis.XMLHttpRequest=XHR;const updates=[],result=uploadResponse('https://app.test/upload',new Blob(['1234567890']),undefined,n=>updates.push(n),globalThis.fetch,{}, {idleMs:100,maxMs:1000});
 const failed=assert.rejects(result,e=>e.name==='TimeoutError');assert.equal(xhr.timeout,0);
 for(let i=1;i<=4;i++){t.mock.timers.tick(90);xhr.upload.onprogress({loaded:i});}assert.deepEqual(updates,[1,2,3,4]);
 xhr.upload.onprogress({loaded:4});t.mock.timers.tick(99);xhr.upload.onprogress({loaded:4});t.mock.timers.tick(1);await failed;
});
test('total cap stops an endlessly progressing upload and cleanup prevents late progress callbacks',async t=>{
 const original=globalThis.XMLHttpRequest;t.after(()=>{globalThis.XMLHttpRequest=original;t.mock.timers.reset()});t.mock.timers.enable({apis:['setTimeout']});
 let xhr;class XHR{constructor(){xhr=this;this.upload={};}open(){}send(){}abort(){this.onabort();}}globalThis.XMLHttpRequest=XHR;
 const updates=[],result=uploadResponse('https://app.test/upload',new Blob(['1234567890']),undefined,n=>updates.push(n),globalThis.fetch,{}, {idleMs:100,maxMs:300});const failed=assert.rejects(result,e=>e.name==='TimeoutError');
 for(let i=1;i<=3;i++){t.mock.timers.tick(90);xhr.upload.onprogress({loaded:i});}t.mock.timers.tick(30);await failed;xhr.upload.onprogress({loaded:8});assert.deepEqual(updates,[1,2,3]);
});
test('progress callback cancellation/error settles upload and aborts its request rather than hanging',async t=>{
 const original=globalThis.XMLHttpRequest;t.after(()=>{globalThis.XMLHttpRequest=original;});let xhr,aborts=0;
 class XHR{constructor(){xhr=this;this.upload={};}open(){}send(){}abort(){aborts++;this.onabort();}}globalThis.XMLHttpRequest=XHR;
 const promise=uploadResponse('https://app.test/upload',new Blob(['abc']),undefined,()=>{throw new DOMException('身份已变化','AbortError')});xhr.upload.onprogress({loaded:1});await assert.rejects(promise,e=>e.name==='AbortError');assert.equal(aborts,1);
});
test('fetch upload rejects late success after explicit pause without reporting complete progress',async()=>{
 const ctl=new AbortController(),updates=[];let release;
 const work=uploadResponse('https://app.test/upload',new Blob(['bytes']),ctl.signal,n=>updates.push(n),()=>new Promise(resolve=>release=resolve));
 ctl.abort();release(Response.json({state:'staged'}));await assert.rejects(work,error=>error.name==='AbortError');assert.deepEqual(updates,[]);
});
test('fetch upload preserves timeout even when an adapter resolves after its abort',async()=>{
 const updates=[];
 const fetcher=(_url,{signal})=>new Promise(resolve=>signal.addEventListener('abort',()=>resolve(Response.json({state:'staged'})),{once:true}));
 const work=uploadResponse('https://app.test/upload',new Blob(['bytes']),undefined,n=>updates.push(n),fetcher,{}, {idleMs:10,maxMs:20});
 const keepAlive=setTimeout(()=>{},100);try{await assert.rejects(work,error=>error.name==='TimeoutError');assert.deepEqual(updates,[]);}finally{clearTimeout(keepAlive);}
});

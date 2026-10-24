import test from 'node:test';import assert from 'node:assert/strict';import {streamDownload,fetchDownloadResponse,consumeDownloadStream} from '../src/native/download-stream.mjs';
const settle=()=>new Promise(r=>setImmediate(r));
test('download streams exact bytes and estimates without accumulating the entire file',async()=>{
 let i=0;const parts=[];const fetcher=async(_url,options)=>{assert.equal(options.credentials,'include');assert.equal(options.redirect,'error');return new Response(new ReadableStream({pull(c){if(i<3)c.enqueue(Uint8Array.of(++i));else c.close();}}),{headers:{'content-length':'3'}})};
 await streamDownload('https://app.test/file',{fetcher,credentials:'include',onChunk:async(bytes,total)=>{parts.push([...bytes]);assert.equal(total,3)}});assert.deepEqual(parts,[[1],[2],[3]]);
});
test('stalled response headers time out and abort the request',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});t.after(()=>t.mock.timers.reset());let signal;
 const promise=streamDownload('https://app.test/file',{idleMs:100,fetcher:async(_url,o)=>{signal=o.signal;return new Promise(()=>{})},onChunk:()=>{}}),failed=assert.rejects(promise,e=>e.name==='TimeoutError');t.mock.timers.tick(100);await failed;assert.equal(signal.aborted,true);
});
test('stalled response body times out and cancels its reader; partial bytes remain incomplete',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});t.after(()=>t.mock.timers.reset());let stopped=false,chunks=0;
 const stream=new ReadableStream({start(c){c.enqueue(Uint8Array.of(1));},cancel(){stopped=true;}});
 const promise=streamDownload('https://app.test/file',{idleMs:100,fetcher:async()=>new Response(stream),onChunk:()=>chunks++}),failed=assert.rejects(promise,e=>e.name==='TimeoutError');await settle();t.mock.timers.tick(100);await failed;assert.equal(stopped,true);assert.equal(chunks,1);
});
test('advancing download has no whole-transfer two-minute cap and local processing does not consume network idle budget',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});t.after(()=>t.mock.timers.reset());let controller,processed=0,release;
 const response=new Response(new ReadableStream({start(c){controller=c;}}));
 const promise=streamDownload('https://app.test/file',{idleMs:100,fetcher:async()=>response,onChunk:async()=>{processed++;if(processed===1)await new Promise(r=>release=r)}});
 await settle();controller.enqueue(Uint8Array.of(1));await settle();t.mock.timers.tick(500);release();await settle();
 for(let i=0;i<3;i++){t.mock.timers.tick(90);controller.enqueue(Uint8Array.of(i));await settle();}controller.close();await promise;assert.equal(processed,4);
});
test('explicit cancellation and verifier failure release the stream without claiming a timeout',async()=>{
 let stopped=false;const ctl=new AbortController(),stream=new ReadableStream({cancel(){stopped=true;}});
 const promise=streamDownload('https://app.test/file',{signal:ctl.signal,fetcher:async()=>new Response(stream),onChunk:()=>{}});await settle();ctl.abort();await assert.rejects(promise,e=>e.name==='AbortError');assert.equal(stopped,true);
 let cancelled=false;const other=new ReadableStream({start(c){c.enqueue(Uint8Array.of(1));},cancel(){cancelled=true;}});await assert.rejects(streamDownload('https://app.test/file',{fetcher:async()=>new Response(other),onChunk:()=>{throw Error('integrity failed')}}),/integrity failed/);assert.equal(cancelled,true);
});

test('real HTTP stalled body reports TimeoutError and closes its stream',async()=>{
 const {createServer}=await import('node:http');let closed=false,received=0;
 const server=createServer((_req,res)=>{res.writeHead(200,{'content-type':'application/octet-stream'});res.write('x');res.on('close',()=>closed=true);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{await assert.rejects(streamDownload('http://127.0.0.1:'+server.address().port+'/file',{idleMs:200,onChunk:bytes=>received+=bytes.length}),e=>e.name==='TimeoutError');assert.equal(received,1);await new Promise(r=>setTimeout(r,30));assert.equal(closed,true);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('late response headers after timeout release their unused body',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});t.after(()=>t.mock.timers.reset());let release,cancelled=false;
 const body=new ReadableStream({cancel(){cancelled=true;}});
 const work=fetchDownloadResponse('https://app.test/file',{idleMs:100,fetcher:()=>new Promise(resolve=>release=resolve)}),failed=assert.rejects(work,e=>e.name==='TimeoutError');
 t.mock.timers.tick(100);await failed;release(new Response(body));await settle();assert.equal(cancelled,true);
});
test('unbounded provider cleanup cannot keep a timed-out reader running',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});t.after(()=>t.mock.timers.reset());let cancelled=false;
 const body=new ReadableStream({cancel(){cancelled=true;return new Promise(()=>{});}});
 const work=consumeDownloadStream(body,{idleMs:100,onChunk:()=>{}}),failed=assert.rejects(work,e=>e.name==='TimeoutError');t.mock.timers.tick(100);await failed;assert.equal(cancelled,true);assert.equal(body.locked,false);
});

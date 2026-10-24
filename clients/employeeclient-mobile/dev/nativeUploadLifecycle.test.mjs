import test from 'node:test';import assert from 'node:assert/strict';import {Readable} from 'node:stream';import {EventEmitter} from 'node:events';import {setTimeout as delay} from 'node:timers/promises';import {relayNativeUpload} from '../server/native-upload.mjs';
const project='cfe3f0af-af84-4c63-a0d6-2d0677caaddd',op='8662ae87-2e86-405e-aa76-c2b6e807b0b1';
function request(source,size){const req=Readable.from(source);req.url='/native/upload?'+new URLSearchParams({project_id:project,operation_id:op,size:String(size)});req.headers={cookie:'fixture', 'content-length':String(size)};return req;}
const json=v=>new Response(JSON.stringify(v));
const setup=(provider)=>async(url,options)=>{if(url.endsWith('/get-session'))return json({session:{token:'fixture',expiresAt:new Date(Date.now()+60000).toISOString()}});if(url.endsWith('/put-ticket'))return json({state:'uploading',size:6,ticket:{method:'PUT',url:'https://provider.test/object'}});return provider(options);};
test('advancing bytes survive more than one idle window',async()=>{
 const req=request((async function*(){for(let i=0;i<6;i++){await delay(20);yield Buffer.from('a');}})(),6),replies=[];
 await relayNativeUpload(req,(status,body)=>replies.push({status,body}),setup(async o=>{let count=0;for await(const b of o.body)count+=b.length;assert.equal(count,6);return new Response('');}),()=>{},{idleMs:65,maxMs:1000});assert.equal(replies[0].status,200);
});
test('stuck provider ignoring abort returns timeout; late success cannot stage',async t=>{
 const keepAlive=setInterval(()=>{},1000);t.after(()=>clearInterval(keepAlive));
 let done,signal,cancelled=0;const replies=[],req=request([Buffer.from('aaaaaa')],6);
 const running=relayNativeUpload(req,(status,body)=>replies.push({status,body}),setup(async o=>{signal=o.signal;for await(const _ of o.body){}return new Promise(r=>done=r);}),()=>{},{idleMs:35,maxMs:1000});await running;assert.equal(signal.aborted,true);assert.equal(replies[0].status,504);done(new Response(new ReadableStream({cancel(){cancelled++;}})));await delay(0);assert.equal(cancelled,1);assert.equal(replies.length,1);
});
test('response connection closing after body delivery cancels provider and rejects late stage',async()=>{
 let done,signal,started;const ready=new Promise(r=>started=r),replies=[],response=new EventEmitter();response.writableEnded=false;
 const running=relayNativeUpload(request([Buffer.from('aaaaaa')],6),(status,body)=>replies.push({status,body}),setup(async o=>{signal=o.signal;for await(const _ of o.body){}started();return new Promise(r=>done=r);}),()=>{},{response,idleMs:500,maxMs:1000});await ready;response.destroyed=true;response.emit('close');await running;assert.equal(signal.aborted,true);done(new Response(''));await delay(0);assert.equal(replies.length,0);assert.equal(response.listenerCount('close'),0);
});
test('cancel during delayed ticket never starts provider transfer',async()=>{
 let resolveTicket,ready,providers=0;const ticketStarted=new Promise(r=>ready=r),req=request([Buffer.from('aaaaaa')],6),replies=[];
 const running=relayNativeUpload(req,(s,b)=>replies.push({s,b}),async(url)=>{if(url.endsWith('/get-session'))return json({session:{token:'fixture',expiresAt:new Date(Date.now()+60000).toISOString()}});if(url.endsWith('/put-ticket')){ready();return new Promise(r=>resolveTicket=r);}providers++;return new Response('');},()=>{},{idleMs:500,maxMs:1000});await ticketStarted;req.emit('aborted');await running;resolveTicket(json({state:'uploading',size:6,ticket:{method:'PUT',url:'https://provider.test/object'}}));await delay(0);assert.equal(providers,0);assert.equal(replies[0].s,499);
});
test('provider success without consuming exact request bytes cannot stage',async()=>{
 const replies=[];await relayNativeUpload(request([Buffer.from('aaaaaa')],6),(status,body)=>replies.push({status,body}),setup(async()=>new Response('')));assert.equal(replies[0].status,400);assert.equal(replies[0].body.error_code,'upload_size_mismatch');
});

test('stalled incoming bytes release the request and never stage',async()=>{
 const req=request((async function*(){yield Buffer.from('a');await delay(100);yield Buffer.from('aaaaa');})(),6),replies=[];
 await relayNativeUpload(req,(status,body)=>replies.push({status,body}),setup(async o=>{for await(const _ of o.body){}return new Response('');}),()=>{},{idleMs:30,maxMs:1000});assert.equal(replies[0].status,504);assert.equal(req.destroyed,true);
});
test('total cap still bounds an advancing upload',async()=>{
 const req=request((async function*(){for(let i=0;i<6;i++){await delay(25);yield Buffer.from('a');}})(),6),replies=[];
 await relayNativeUpload(req,(status,body)=>replies.push({status,body}),setup(async o=>{for await(const _ of o.body){}return new Response('');}),()=>{},{idleMs:60,maxMs:90});assert.equal(replies[0].status,504);assert.equal(req.destroyed,true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const settle=()=>new Promise(r=>setImmediate(r));
async function fixture(t,{cooperative=true,initialPending=false}={}){
 const key='__qn_stream_'+Math.random().toString(36).slice(2),events=[],calls=[];
 let streamController,push,renew,clock=1000000,valid=true;
 class ApiError extends Error{constructor(code,message,status){super(message);this.code=code;this.status=status;}get needsAuth(){return this.code==='unauthenticated';}}
 const body=new ReadableStream({start(c){streamController=c;push=(type,data={})=>c.enqueue(new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));}});
 const deps={registerPlugin:()=>({}),captureApiLease:()=>({account:'a',valid:()=>valid}),ApiError,servicePath:p=>p,metaGet:async()=>0,isAndroidNative:()=>false};
 globalThis[key]=deps;
 const source=await readFile(new URL('../src/platform/liveTransport.ts',import.meta.url),'utf8');
 const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/^import .*;\n/gm,'');
 const mod=await import('data:text/javascript;base64,'+Buffer.from(`const {registerPlugin,captureApiLease,ApiError,servicePath,metaGet,isAndroidNative}=globalThis[${JSON.stringify(key)}];\n`+compiled).toString('base64'));
 t.mock.method(Date,'now',()=>clock);
 const oldWindow=globalThis.window;globalThis.window={location:{href:'https://app.example/'}};
 t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push(url);if(url==='/native/session'){if(!initialPending&&calls.filter(x=>x===url).length===1)return new Response(JSON.stringify({identity:{actor_id:'a'}}));return new Promise(r=>renew=r);}if(cooperative)options.signal.addEventListener('abort',()=>{try{streamController.close();}catch{}},{once:true});return new Response(body,{headers:{'content-type':'text/event-stream'}});});
 const abort=new AbortController(),work=mod.connectStream('a','g',abort.signal,e=>events.push(e)).catch(error=>{if(!abort.signal.aborted&&!events.some(e=>e.type==='auth'))throw error;});await settle();if(!initialPending){push('ready',{actor_id:'a'});await settle();}
 return {events,calls,push,pause:()=>abort.abort(),advance:()=>clock+=31*60000,renew:(status,actor)=>renew(new Response(JSON.stringify(actor?{identity:{actor_id:actor}}:{}),{status})),invalidate:()=>valid=false,close:async()=>{abort.abort();await work;globalThis.window=oldWindow;delete globalThis[key];}};
}
test('slow renewal leaves SSE delivery running and concurrent heartbeats share one renewal',async t=>{
 const f=await fixture(t);try{f.advance();f.push('ping');await settle();f.push('ping');f.push('change',{kind:'chat_message'});await settle();assert.equal(f.calls.filter(x=>x==='/native/session').length,2);assert.ok(f.events.some(e=>e.type==='change'));f.renew(503);await settle();f.push('change');await settle();assert.equal(f.events.at(-1).type,'change');assert.ok(!f.events.some(e=>e.type==='auth'));}finally{await f.close();}
});
for(const status of [401,403])test(`renewal ${status} terminates stream instead of keeping rejected authority`,async t=>{
 const f=await fixture(t);try{f.advance();f.push('ping');await settle();f.renew(status);await settle();assert.equal(f.events.at(-1).type,'auth');assert.equal(f.events.at(-1).status,status);}finally{await f.close();}
});

test('renewed identity mismatch stops delivery; a stale account lease cannot emit auth for the new account',async t=>{
 const f=await fixture(t);try{f.advance();f.push('ping');await settle();f.renew(200,'other');await settle();assert.equal(f.events.at(-1).type,'auth');}finally{await f.close();}
});
test('renewal rejection from a replaced account lease is ignored',async t=>{
 const f=await fixture(t);try{f.advance();f.push('ping');await settle();f.invalidate();f.renew(401);await settle();assert.ok(!f.events.some(e=>e.type==='auth'));}finally{await f.close();}
});
test('a late initial session response after cancellation cannot start a new event request',async t=>{
 const f=await fixture(t,{initialPending:true});try{f.pause();f.renew(200,'a');await settle();assert.deepEqual(f.calls,['/native/session']);}finally{await f.close();}
});
test('late stream bytes after cancellation cannot deliver a change event',async t=>{
 const f=await fixture(t,{cooperative:false});try{f.pause();f.push('change',{kind:'chat_message'});await settle();assert.ok(!f.events.some(e=>e.type==='change'));}finally{await f.close();}
});

import {createRecoveryGate as realRecoveryGate} from '../src/platform/recoveryGate.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url)).replace(/\/$/,'');
const ts=createRequire(root+'/package.json')('typescript'),settle=()=>new Promise(r=>setImmediate(r));
async function moduleWith(path,deps){const key='__audit_'+Math.random().toString(36).slice(2);globalThis[key]={...deps,createRecoveryGate:o=>realRecoveryGate({...o,setTimer:(fn,ms)=>setTimeout(fn,ms),clearTimer:id=>clearTimeout(id)})};deps=globalThis[key];const source=await readFile(root+'/'+path,'utf8');const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/^import .*;\n/gm,'');return {mod:await import('data:text/javascript;base64,'+Buffer.from(`const {${Object.keys(deps).join(',')}}=globalThis[${JSON.stringify(key)}];\n`+compiled).toString('base64')),close:()=>delete globalThis[key]};}
class ApiError extends Error{constructor(code,hint,status){super(hint);this.code=code;this.status=status;}get needsAuth(){return this.code==='unauthenticated';}}
for(const ready of [false,true])test(`PWA expires incomplete bytes and reconnects after deadline (${ready?'post-ready':'pre-ready'})`,async t=>{
 let bodyController,streamSignal;const events=[];const originalWindow=globalThis.window;globalThis.window={location:{href:'https://app.example/'}};
 const f=await moduleWith('src/platform/liveTransport.ts',{registerPlugin:()=>({}),captureApiLease:()=>({account:'a',valid:()=>true}),ApiError,servicePath:p=>p,metaGet:async()=>0,isAndroidNative:()=>false});
 t.mock.timers.enable({apis:['setTimeout']});
 t.mock.method(globalThis,'fetch',async(url,o)=>{streamSignal=o.signal;return new Response(new ReadableStream({start(c){bodyController=c;o.signal.addEventListener('abort',()=>c.close(),{once:true});}}),{headers:{'content-type':'text/event-stream'}});});
 const ctl=new AbortController();let ended=false;f.mod.noteVerifiedTransportIdentity('a');const work=f.mod.connectStream('a','g',ctl.signal,e=>events.push(e)).catch(()=>{}).finally(()=>ended=true);
 const push=s=>bodyController.enqueue(new TextEncoder().encode(s));
 try{await settle();if(ready){push('event: ready\ndata: {"actor_id":"a"}\n\n');await settle();}
 t.mock.timers.tick(30000);push(': partial\n');await settle();assert.equal(streamSignal.aborted,false);
 t.mock.timers.tick(15000);await settle();assert.equal(streamSignal.aborted,true);assert.equal(ended,true);assert.equal(events.filter(e=>e.type==='change').length,0);
 }finally{ctl.abort();await work;t.mock.timers.reset();globalThis.window=originalWindow;f.close();}
});
test('complete verified PWA heartbeats keep a healthy stream alive without business events',async t=>{
 let feeder;const events=[];let aborted=false;const old=globalThis.window;globalThis.window={location:{href:'https://app.example/'}};
 const f=await moduleWith('src/platform/liveTransport.ts',{registerPlugin:()=>({}),captureApiLease:()=>({account:'a',valid:()=>true}),ApiError,servicePath:p=>p,metaGet:async()=>0,isAndroidNative:()=>false});t.mock.timers.enable({apis:['setTimeout']});
 t.mock.method(globalThis,'fetch',async(_url,o)=>new Response(new ReadableStream({start(c){feeder=c;o.signal.addEventListener('abort',()=>{aborted=true;c.close();},{once:true});}}),{headers:{'content-type':'text/event-stream'}}));
 const ctl=new AbortController();f.mod.noteVerifiedTransportIdentity('a');const work=f.mod.connectStream('a','g',ctl.signal,e=>events.push(e)).catch(()=>{});const push=s=>feeder.enqueue(new TextEncoder().encode(s));
 try{await settle();push('event: ready\ndata: {"actor_id":"a"}\n\n');await settle();for(let i=0;i<10;i++){t.mock.timers.tick(30000);push('event: ping\ndata: {}\n\n');await settle();}assert.equal(aborted,false);assert.equal(events.filter(e=>e.type==='ping').length,10);assert.equal(events.filter(e=>e.type==='change').length,0);}finally{ctl.abort();await work;t.mock.timers.reset();globalThis.window=old;f.close();}
});
test('new events and foreground wakes merge without bypassing failed sync backoff',async t=>{
 let receive;const calls=[];const f=await moduleWith('src/platform/liveLink.ts',{App:{addListener:async()=>({remove:async()=>{}})},Network:{addListener:async()=>({remove:async()=>{}})},ApiError,isOnline:()=>true,isAndroidNative:()=>false,NativeLive:{},connectStream:(account,g,signal,fn)=>{receive=fn;return new Promise(r=>signal.addEventListener('abort',r,{once:true}));}});t.mock.timers.enable({apis:['setTimeout']});
 try{f.mod.startLiveLink({account:'a',shouldRun:()=>true,onTick:async(mode,hint)=>{calls.push({mode,hint});if(calls.length===1)throw Error('outage');}});await settle();receive({type:'ready'});await settle();
 for(let i=0;i<20;i++){receive({type:'change',data:{kinds:['chat_message'],conversation_peers:['peer-'+i]}});await settle();}f.mod.pokeLiveLink();await settle();assert.equal(calls.length,1);
 t.mock.timers.tick(1999);await settle();assert.equal(calls.length,1);t.mock.timers.tick(1);await settle();assert.equal(calls.length,2);assert.equal(calls[1].mode,'catchup');assert.equal(calls[1].hint.conversationPeers.length,20);assert.ok(calls[1].hint.kinds.includes('chat_message'));
 t.mock.timers.tick(60000);await settle();assert.equal(calls.length,2);
 }finally{f.mod.stopLiveLink();t.mock.timers.reset();f.close();}
});

import {createRecoveryGate as realRecoveryGate} from '../src/platform/recoveryGate.mjs';
// Focused scheduler checks. Transport itself is exercised by V8's real HTTP SSE test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const settle = () => new Promise(r => setImmediate(r));
test('native resumed ready preserves the live connection without duplicate recovery or wake',async()=>{
 const f=await fixture();let wakes=0,ticks=0;try{
  f.mod.startLiveLink({account:'a',shouldRun:()=>true,onWake:()=>wakes++,onTick:async()=>ticks++});await settle();
  f.connections[0].receive({type:'ready',data:{catchup:true}});await settle();const before=f.mod.liveLinkSnapshot();
  f.connections[0].receive({type:'ready',data:{resumed:true,catchup:true}});await settle();
  assert.equal(wakes,1);assert.equal(ticks,0);assert.equal(f.mod.liveLinkSnapshot().rebuiltCount,before.rebuiltCount);assert.equal(f.connections.length,1);
 }finally{f.close();}
});
async function fixture() {
  const connections = [], inputs = new Map();
  const listen = async (name, fn) => { inputs.set(name, fn); return { remove: async () => inputs.delete(name) }; };
  class ApiError extends Error { constructor(code, hint, status) { super(hint); this.code=code; this.status=status; } get needsAuth(){return this.code==='unauthenticated';} }
  const key='__qn_live_'+Math.random().toString(36).slice(2);
  globalThis[key] = {
    createRecoveryGate:o=>realRecoveryGate({...o,setTimer:(fn,ms)=>setTimeout(fn,ms),clearTimer:id=>clearTimeout(id)}), App: { addListener: listen }, Network: { addListener: listen }, ApiError, isOnline: () => true,
    isAndroidNative: () => false, NativeLive: {},
    connectStream: (account, generation, signal, receive) => new Promise((resolve,reject) => {
      connections.push({ account, generation, receive, reject, signal });
      signal.addEventListener('abort', resolve, { once: true });
    }),
  };
  const text = await readFile(new URL('../src/platform/liveLink.ts', import.meta.url),'utf8');
  const compiled = ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/^import .*;\n/gm,'');
  const prefix=`const {createRecoveryGate,App,Network,ApiError,isOnline,isAndroidNative,NativeLive,connectStream}=globalThis[${JSON.stringify(key)}];\n`;
  const mod=await import('data:text/javascript;base64,'+Buffer.from(prefix+compiled).toString('base64'));
  return { mod,connections,inputs,close:()=>{mod.stopLiveLink();delete globalThis[key];} };
}
test('only ready/change trigger sync; an event during sync schedules another pass', async () => {
  const f=await fixture(); let done; const calls=[];
  try {
    f.mod.startLiveLink({account:'a',shouldRun:()=>true,onTick:mode=>{calls.push(mode);return calls.length===1?new Promise(r=>done=r):Promise.resolve();}});
    await settle(); assert.deepEqual(calls,[]);
    f.connections[0].receive({type:'ready'}); await settle();
    f.connections[0].receive({type:'change',data:{}}); done(); await settle(); await settle();
    assert.deepEqual(calls,['catchup','live']);
    assert.equal(f.mod.liveLinkState(),'live');
    await settle(); assert.equal(calls.length,2);
  } finally { f.close(); }
});
test('stopped generation cannot resurrect connection or overwrite the next session', async () => {
  const f=await fixture(); let done; let fresh=0;
  try {
    f.mod.startLiveLink({account:'old',shouldRun:()=>true,onTick:()=>new Promise(r=>done=r)});
    f.connections[0].receive({type:'ready'}); await settle();
    f.mod.stopLiveLink();
    f.mod.startLiveLink({account:'new',shouldRun:()=>true,onTick:async()=>{fresh++;}});
    f.connections.at(-1).receive({type:'ready'});
    f.connections[0].receive({type:'change'}); done(); await settle(); await settle();
    assert.equal(fresh,1); assert.equal(f.mod.liveLinkState(),'live');
  } finally { f.close(); }
});
test('transient sync failure retries automatically; reconnect errors do not permanently stop', async t => {
  const f=await fixture(); let attempts=0;
  t.mock.timers.enable({apis:['setTimeout']});
  try {
    f.mod.startLiveLink({account:'a',shouldRun:()=>true,onTick:async()=>{if(++attempts===1)throw new Error('temporary');}});
    f.connections[0].receive({type:'ready'}); await settle();
    assert.equal(f.mod.liveLinkState(),'backoff');
    t.mock.timers.tick(2500); await settle(); assert.equal(attempts,2);
    f.connections[0].reject(new Error('socket reset')); await settle();
    t.mock.timers.tick(2500); await settle(); assert.equal(f.connections.length,2);
    f.connections[1].receive({type:'ready'}); await settle(); assert.equal(f.mod.liveLinkState(),'live');
  } finally { f.close(); t.mock.timers.reset(); }
});
test('chat wake is independent of blocked work sync and stale stream generations', async () => {
 const f=await fixture();let done;let wakes=0;
 try {
  f.mod.startLiveLink({account:'a',shouldRun:()=>true,onWake:()=>wakes++,onTick:()=>new Promise(r=>done=r)});
  const old=f.connections[0];old.receive({type:'ready'});await settle();assert.equal(wakes,1);
  old.receive({type:'change',data:{kind:'chat_message'}});assert.equal(wakes,1);
  f.mod.pokeLiveLink();assert.equal(wakes,2);
  f.mod.stopLiveLink();old.receive({type:'change',data:{}});assert.equal(wakes,2);
  done();await settle();
 } finally {f.close();}
});

test('ready followed by cursor catch-up performs one recovery; heartbeats never read business data', async () => {
 const f=await fixture(),calls=[];
 try {
  f.mod.startLiveLink({account:'a',shouldRun:()=>true,onTick:async(mode)=>calls.push(mode)});
  f.connections[0].receive({type:'ready',data:{catchup:true}});await settle();assert.equal(calls.length,0);
  f.connections[0].receive({type:'change',data:{catchup:true,kinds:[]}});await settle();
  for(let i=0;i<8;i++)f.connections[0].receive({type:'ping',data:{}});
  await settle();assert.deepEqual(calls,['catchup']);
 }finally{f.close();}
});

test('manual recovery shares event serialization and keeps a queued cursor catch-up',async()=>{
 const f=await fixture();let release,calls=0;try{f.mod.startLiveLink({account:'a',shouldRun:()=>true,onTick:async()=>{calls++;if(calls===1)await new Promise(r=>release=r);}});await settle();f.connections[0].receive({type:'ready'});await settle();const recovery=f.mod.recoverLiveSync();assert.equal(calls,1);release();await recovery;assert.equal(calls,2);assert.ok(f.mod.liveLinkSnapshot().lastTickAt);assert.equal(f.mod.liveLinkState(),'live');}finally{f.close();}
});
test('failed manual recovery reports the pending retry instead of claiming a completed synchronization',async()=>{
 const f=await fixture();try{f.mod.startLiveLink({account:'a',shouldRun:()=>true,onTick:async()=>{throw Error('temporary offline');}});await settle();await assert.rejects(f.mod.recoverLiveSync(),/同步暂未完成/);assert.equal(f.mod.liveLinkSnapshot().lastTickAt,null);}finally{f.close();}
});

test('confirmed identity restarts a rejected transport without rebuilding hooks or work area',async()=>{
 const f=await fixture();let losses=0,ticks=0;
 try{f.mod.startLiveLink({account:'a',shouldRun:()=>true,onTick:async()=>ticks++,onAuthLost:()=>losses++});await settle();
 f.connections[0].receive({type:'ready',data:{catchup:true}});
 f.connections[0].receive({type:'auth',data:{status:401}});await settle();assert.equal(losses,1);assert.ok(f.connections[0].signal.aborted);
 f.mod.restartVerifiedTransport();await settle();assert.equal(f.connections.length,2);assert.equal(f.connections[1].account,'a');
 f.connections[1].receive({type:'ready',data:{catchup:true}});f.connections[1].receive({type:'change',data:{catchup:true,kinds:[]}});await settle();assert.equal(ticks,1);assert.equal(f.mod.liveLinkState(),'live');
 }finally{f.close();}
});

test('foreground and network wakes cannot restart a transport while identity verification is pending',async()=>{
 const f=await fixture();let losses=0,ticks=0;try{
  f.mod.startLiveLink({account:'a',shouldRun:()=>true,onTick:async()=>ticks++,onAuthLost:()=>losses++});await settle();
  f.connections[0].receive({type:'auth',data:{status:401}});await settle();
  for(let i=0;i<10;i++)f.mod.pokeLiveLink();await settle();
  assert.equal(losses,1);assert.equal(ticks,0);assert.equal(f.connections.length,1);
  f.mod.restartVerifiedTransport();await settle();assert.equal(f.connections.length,2);
  f.connections[1].receive({type:'ready',data:{catchup:true}});f.connections[1].receive({type:'change',data:{catchup:true}});await settle();assert.equal(ticks,1);
 }finally{f.close();}
});

test('failed catch-up stays catch-up even when a live event queues during its flight',async t=>{
 const f=await fixture();let rejectFirst;const modes=[];t.mock.timers.enable({apis:['setTimeout']});
 try{f.mod.startLiveLink({account:'a',shouldRun:()=>true,onTick:mode=>{modes.push(mode);return modes.length===1?new Promise((_,reject)=>rejectFirst=reject):Promise.resolve();}});await settle();f.connections[0].receive({type:'ready'});await settle();f.connections[0].receive({type:'change',data:{kinds:['chat_message']}});rejectFirst(Error('network switched'));await settle();t.mock.timers.tick(2500);await settle();assert.deepEqual(modes,['catchup','catchup']);}finally{f.close();t.mock.timers.reset();}
});

test('new UI attached to an existing native socket catches up once, repeated ready does not duplicate it',async()=>{
 const f=await fixture();let ticks=0,wakes=0;try{f.mod.startLiveLink({account:'a',shouldRun:()=>true,onTick:async mode=>{assert.equal(mode,'catchup');ticks++;},onWake:()=>wakes++});await settle();f.connections[0].receive({type:'ready',data:{resumed:true,catchup:true}});await settle();assert.equal(ticks,1);assert.equal(wakes,1);f.connections[0].receive({type:'ready',data:{resumed:true,catchup:true}});await settle();assert.equal(ticks,1);assert.equal(wakes,1);assert.equal(f.connections.length,1);}finally{f.close();}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const built=await build({entryPoints:['src/chat/viewResume.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {readViewResume,viewRange,restoreViewWindow}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
const point={anchor:{id:'m200',y:1200,offset:23.5},latest:false,unread:2};
const state={schema:1,peer:'b',filter:{peer:'b',q:'saved',kind:'links',author:'b',related:'mentions',created_from:1,created_until:100},searchText:'not yet submitted',searchOpen:true,historyDate:'2026-10-15',historyNote:'date',point,queryRange:{oldest:100,newest:350,count:251},context:{target:'m120',range:{oldest:95,newest:145,count:51},origin:point}};
test('read state preserves submitted filters, unsubmitted input, context origin and independent window ranges',()=>{
 const restored=readViewResume(state,'b');assert.deepEqual(restored,state);restored.filter.q='new';assert.equal(state.filter.q,'saved');assert.equal(readViewResume(null,'b'),null);
});
test('wrong peer, corrupt ranges, unbounded content and unsupported fields cannot restore as trusted preferences',()=>{
 const bad=[{...state,peer:'a'},{...state,filter:{peer:'a'}},{...state,filter:{kind:'unknown'}},{...state,filter:{created_from:-1}},{...state,filter:{unexpected:'x'}},{...state,queryRange:{oldest:1,newest:2,count:Infinity}},{...state,point:{...point,anchor:{...point.anchor,y:NaN}}},{...state,context:{target:'x',range:null,origin:point}},{...state,searchText:'x'.repeat(4001)}];for(const value of bad)assert.throws(()=>readViewResume(value,'b'));
});
function source(){const calls=[],rows=Array.from({length:600},(_,i)=>({id:'m'+(i+1),seq:i+1,conversation_peer:'b',change_version:1,body:'saved',reply_to:null}));return {calls,messages:async(q,signal)=>{signal?.throwIfAborted();calls.push(q);let matches=rows.filter(m=>q.before?m.seq<q.before:m.seq>q.after);const total=matches.length;matches=q.before?matches.slice(-q.limit):matches.slice(0,q.limit);return {messages:matches,oldest_cursor:matches[0]?.seq,has_more_old:total>q.limit,has_more:total>q.limit,sync_cursor:700};}};}
test('restores only the original 251-row query interval without scanning newer history',async()=>{
 const f=source(),r=await restoreViewWindow(f,{peer:'b',q:'saved'},state.queryRange,new AbortController().signal);assert.equal(r.messages.length,251);assert.equal(r.messages[0].seq,100);assert.equal(r.messages.at(-1).seq,350);assert.equal(r.hasOlder,true);assert.equal(r.hasNewer,true);assert.equal(f.calls.length,4);assert.deepEqual(f.calls.map(c=>c.before||c.after),[351,251,151,350]);assert.ok(f.calls.every(c=>c.peer==='b'&&c.q==='saved'));assert.deepEqual(viewRange(r.messages),state.queryRange);
});
test('range gaps and removed messages preserve the actual available rows rather than manufacturing old text',async()=>{
 const f=source(),original=f.messages;f.messages=async(...args)=>{const r=await original(...args);r.messages=r.messages.filter(m=>m.seq!==200);return r;};const r=await restoreViewWindow(f,{peer:'b'},{oldest:180,newest:220,count:41},new AbortController().signal);assert.equal(r.messages.length,40);assert.ok(!r.messages.some(m=>m.seq===200));
});
test('wrong conversation, stalled pagination and cancellation stop restoration',async()=>{
 await assert.rejects(restoreViewWindow({messages:async()=>({messages:[{id:'x',seq:2,conversation_peer:'a'}],has_more_old:false,sync_cursor:8})},{peer:'b'},{oldest:1,newest:3,count:3},new AbortController().signal),/范围/);
 await assert.rejects(restoreViewWindow({messages:async()=>({messages:[{id:'x',seq:3,conversation_peer:'b'}],oldest_cursor:4,has_more_old:true,sync_cursor:8})},{peer:'b'},{oldest:1,newest:3,count:3},new AbortController().signal),/分页/);
 const controller=new AbortController(),f=source(),original=f.messages;f.messages=async(...args)=>{const r=await original(...args);controller.abort();return r;};await assert.rejects(restoreViewWindow(f,{peer:'b'},state.queryRange,controller.signal),e=>e.name==='AbortError');assert.equal(f.calls.length,1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const compiled=await build({entryPoints:[fileURLToPath(new URL('../src/chat/context.ts',import.meta.url))],bundle:true,write:false,format:'esm'});
const {loadChatContext,mergeContextMessages}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const row=(seq,extra={})=>({id:'m'+seq,seq,change_version:1,body:'same text',...extra});
function source({target=row(100),newTarget=target,page=()=>({messages:[],sync_cursor:9}),onFirst=()=>{}}={}){
 let calls=0;return {message:async()=>{onFirst(++calls);return {message:calls===1?target:newTarget};},messages:async query=>page(query)};
}
test('context locates by ID rather than repeated text, takes only two bounded surrounding windows',async()=>{
 const queries=[];const result=await loadChatContext(source({page:q=>{queries.push(q);return {messages:q.before?[row(99)]:[row(101)],sync_cursor:q.before?8:9,has_more_old:!!q.before,has_more:!!q.after};}}),'m100','',new AbortController().signal);
 assert.deepEqual(result.messages.map(m=>m.id),['m99','m100','m101']);assert.equal(queries.length,2);assert.ok(queries.every(q=>q.limit===25));assert.equal(result.changeCursor,8);assert.ok(result.hasOlder&&result.hasNewer);
});
test('wrong conversation fails before reading surrounding history',async()=>{
 let pages=0;await assert.rejects(loadChatContext(source({target:row(100,{conversation_peer:'other'}),page:()=>{pages++;return {};}}),'m100','self',new AbortController().signal),/当前会话/);assert.equal(pages,0);
});
test('target recalled during window fetch is revalidated and never displayed as an available original',async()=>{
 await assert.rejects(loadChatContext(source({newTarget:row(100,{recalled:true})}),'m100','',new AbortController().signal),/撤回/);
 await assert.rejects(loadChatContext(source({newTarget:row(100,{hidden:true})}),'m100','',new AbortController().signal),/不可见/);
});
test('cancellation after first lookup prevents all surrounding requests',async()=>{
 const controller=new AbortController();let pages=0;
 await assert.rejects(loadChatContext(source({onFirst:()=>controller.abort(),page:()=>{pages++;return {};}}),'m100','',controller.signal),{name:'AbortError'});assert.equal(pages,0);
});
test('cancellation while pages wait cannot yield a completed context',async()=>{
 const controller=new AbortController();let release;const gate=new Promise(r=>release=r);
 const task=loadChatContext(source({page:async()=>{await gate;return {messages:[],sync_cursor:9};}}),'m100','',controller.signal);
 await new Promise(r=>setImmediate(r));controller.abort();release();await assert.rejects(task,{name:'AbortError'});
});
test('malformed scope/order is rejected and late stale versions cannot restore deleted content',async()=>{
 await assert.rejects(loadChatContext(source({page:()=>({messages:[row(101)],sync_cursor:9})}),'m100','',new AbortController().signal),/顺序/);
 const rows=mergeContextMessages([row(1,{hidden:true,body:'',change_version:3}),row(1,{change_version:1}),row(2)]);
 assert.equal(rows.length,2);assert.equal(rows[0].hidden,true);assert.equal(rows[0].body,'');
});

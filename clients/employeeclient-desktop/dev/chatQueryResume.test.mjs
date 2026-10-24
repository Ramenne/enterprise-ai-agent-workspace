import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {ref,computed,watch,onScopeDispose,effectScope,nextTick} from 'vue';
import {build} from 'esbuild';
const b=await build({entryPoints:['src/chat/viewResume.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {restoreViewWindow}=await import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'));
const code=ts.transpileModule(readFileSync(new URL('../src/chat/query.ts',import.meta.url),'utf8').replace(/^import[^\n]+\n/gm,'').replace('export function','function'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const settle=async()=>{await nextTick();await new Promise(r=>setImmediate(r));};
function fixture(){
 const calls=[],rows=Array.from({length:400},(_,i)=>({id:'m'+(i+1),seq:i+1,conversation_peer:'b',body:'word',change_version:1,reply_to:null}));let handler;
 const defaultRequest=async q=>{calls.push(q);let data=rows.filter(m=>q.before?m.seq<q.before:q.after?m.seq>q.after:true);const total=data.length;data=q.after?data.slice(0,q.limit):data.slice(-q.limit);return {messages:data,oldest_cursor:data[0]?.seq,has_more_old:total>q.limit,has_more:total>q.limit,sync_cursor:600};};handler=defaultRequest;
 const deps={ref,computed,watch,onScopeDispose,userError:e=>e.message,communication:{messages:(...a)=>handler(...a)},mergeChatMessages:items=>[...new Map(items.map(m=>[m.id,m])).values()].sort((a,b)=>a.seq-b.seq),restoreViewWindow};
 const hook=new Function(...Object.keys(deps),code+';return useChatQuery;')(...Object.values(deps));const owner=ref('a'),filter=ref({peer:'b',q:'word'}),scope=effectScope(),query=scope.run(()=>hook(owner,filter));
 return {query,owner,filter,calls,request:defaultRequest,setHandler:f=>handler=f,close:()=>scope.stop()};
}
test('restored detached query supports later pages and preserves its window on live refresh',async()=>{
 const f=fixture();try{await settle();await f.query.restoreWindow({oldest:100,newest:199,count:100});assert.equal(f.query.messages.value.length,100);assert.equal(f.query.hasNewer.value,true);const start=f.calls.length;await f.query.refresh(true);assert.equal(f.query.messages.value.length,100);assert.equal(f.calls.length-start,2);assert.equal(f.calls[start].before,200);await f.query.newer();assert.equal(f.query.messages.value.at(-1).seq,249);assert.equal(f.query.messages.value.length,150);await f.query.older();assert.equal(f.query.messages.value[0].seq,50);}finally{f.close();}
});
test('changing query while old restoration is delayed aborts old rows and loading ownership',async()=>{
 const f=fixture();try{await settle();let release,entered;const gate=new Promise(r=>entered=r);f.setHandler(async(q,signal)=>{if(q.before===200){entered();await new Promise(r=>release=r);}return f.request(q,signal);});const old=f.query.restoreWindow({oldest:100,newest:199,count:100}).catch(e=>e);await gate;f.filter.value={peer:'b',q:'new'};await settle();release();const result=await old;assert.equal(result.name,'AbortError');assert.equal(f.query.messages.value[0].seq,351);assert.equal(f.query.loading.value,false);}finally{f.close();}
});
test('permission refusal clears restored query rows and does not disguise failure as empty success',async()=>{
 const f=fixture();try{await settle();f.setHandler(async()=>{throw Object.assign(Error('denied'),{status:403});});await assert.rejects(f.query.restoreWindow({oldest:100,newest:199,count:100}),/denied/);assert.equal(f.query.messages.value.length,0);assert.equal(f.query.hasNewer.value,false);assert.match(f.query.error.value,/denied/);}finally{f.close();}
});

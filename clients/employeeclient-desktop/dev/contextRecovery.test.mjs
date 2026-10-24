import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {applyChatChanges} from '../src/chat/projection.ts';
const source=readFileSync(new URL('../src/ui/views/ChatView.vue',import.meta.url),'utf8');
const code=ts.transpileModule(source.slice(source.indexOf('async function loadContextPage('),source.indexOf('async function mutateMessage(')),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const row=seq=>({id:'m'+seq,seq,change_version:1,conversation_peer:''});
function fixture(){
 const ref=value=>({value}),restores=[],anchor={id:'m100',offset:24};
 const d={contextController:new AbortController(),quoteGeneration:1,quoteView:ref(true),contextBusy:ref(false),locatingDate:ref(false),peer:ref(''),
  contextMessages:ref([row(100),row(101)]),contextHasOlder:ref(true),contextHasNewer:ref(true),contextRefreshPending:false,contextPositionLock:'m100',returnRevision:1,applyChatChanges,
  contextFailures:ref({older:'',newer:'',refresh:''}),contextCursor:9,contextTarget:'m100',atLatest:ref(false),nextTick:async()=>{},
  reading:{capture:()=>anchor,restore:a=>restores.push(a)},userError:e=>e.message,locateReply:()=>{},
  assertContextScope:(m,p)=>{if(m.conversation_peer!==p)throw Error('scope mismatch');},
  mergeContextMessages:rows=>[...new Map(rows.map(r=>[r.id,r])).values()].sort((a,b)=>a.seq-b.seq),
  communication:{messages:async()=>({messages:[row(99)],has_more_old:true}),changes:async()=>({changes:[],next_change_cursor:9,has_more:false}),message:async()=>({message:row(100)})},
 };
 d.contextRetry={get value(){return d.contextFailures.value.refresh?'refresh':d.contextFailures.value.older?'older':'newer';}};
 const api=new Function(...Object.keys(d),code+';return {loadContextPage,refreshContext,retryContext,gesture(){returnRevision++;},leave(){quoteGeneration++;quoteView.value=false;contextController.abort();}};')(...Object.values(d));
 return {d,api,restores,anchor};
}
test('retrying a failed older page restores the same visible message and offset',async()=>{
 const f=fixture();f.d.communication.messages=async()=>{throw Error('page unavailable');};await f.api.loadContextPage('older');assert.equal(f.d.contextMessages.value.length,2);assert.equal(f.d.contextFailures.value.older,'page unavailable');
 f.d.communication.messages=async()=>({messages:[row(99)],has_more_old:true});await f.api.loadContextPage('older');
 assert.deepEqual(f.d.contextMessages.value.map(x=>x.seq),[99,100,101]);assert.deepEqual(f.restores,[f.anchor]);assert.equal(f.d.contextFailures.value.older,'');
});
test('successful background refresh cannot erase a failed page or its retry direction',async()=>{
 const f=fixture();f.d.contextFailures.value.older='page unavailable';await f.api.refreshContext();assert.equal(f.d.contextFailures.value.older,'page unavailable');assert.equal(f.d.contextRetry.value,'older');
});
test('successful page fetch cannot erase a refresh failure',async()=>{
 const f=fixture();f.d.contextFailures.value.refresh='update unavailable';await f.api.loadContextPage('older');assert.equal(f.d.contextFailures.value.refresh,'update unavailable');assert.equal(f.d.contextRetry.value,'refresh');
});
test('refresh retry reveals the still outstanding page error',async()=>{
 const f=fixture();f.d.contextFailures.value={older:'page unavailable',newer:'',refresh:'update unavailable'};await f.api.refreshContext();assert.equal(f.d.contextFailures.value.refresh,'');assert.equal(f.d.contextRetry.value,'older');
});
test('user scroll during a delayed page response supersedes its saved reading anchor',async()=>{
 const f=fixture();let release;f.d.communication.messages=()=>new Promise(r=>release=r);const pending=f.api.loadContextPage('older');f.api.gesture();release({messages:[row(99)],has_more_old:true});await pending;assert.equal(f.d.contextMessages.value.length,3);assert.equal(f.restores.length,0);
});
test('leaving while a page waits rejects its late rows and reading restoration',async()=>{
 const f=fixture();let release;f.d.communication.messages=()=>new Promise(r=>release=r);const pending=f.api.loadContextPage('older');f.api.leave();release({messages:[row(99)],has_more_old:true});await pending;assert.equal(f.d.contextMessages.value.length,2);assert.equal(f.restores.length,0);
});

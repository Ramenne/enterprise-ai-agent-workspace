import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=readFileSync(new URL('../src/ui/views/ChatView.vue',import.meta.url),'utf8');
const slice=source.slice(source.indexOf('function transcriptViewKey()'),source.indexOf('function hideTranscript('))+source.slice(source.indexOf('function reconcileTranscriptViews(){'),source.indexOf('watch(() => session.businessReady,restoreTranscriptViews);'));
// The removed username watcher is outside the units exercised here.
const code=ts.transpileModule(slice.replace('watch(() => session.user?.username, clearTranscripts);',''),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const attachment={id:'voice',ver:1,sha256:'hash',purpose:'voice'},key='voice:1:hash';
function fixture(){
 const account={user:{username:'a'},businessReady:true},saved={[key]:'old'},requests=new Map(),transcripts={value:{}},messages={value:new Map()},reads=[];let finish;
 const deps={session:account,localStorage:{getItem:()=>JSON.stringify(saved),setItem:()=>{}},transcriptRequests:requests,transcripts,messageMap:messages,transcriptKey:a=>`${a.id}:${a.ver}:${a.sha256}`,isVoiceMessage:a=>a.purpose==='voice',readExistingVoiceTranscript:(id,signal)=>{reads.push({id,signal});return new Promise(resolve=>finish=resolve);}};
 const api=new Function(...Object.keys(deps),code+';return {restoreTranscriptViews,reconcileTranscriptViews};')(...Object.values(deps));
 return {api,requests,transcripts,messages,reads,finish:text=>finish({text}),saved,account};
}
const row=extra=>({id:'old',attachments:[attachment],...extra});
test('query-only original keeps in-flight transcription across unrelated main-window refresh',()=>{
 const f=fixture(),controller=new AbortController();f.messages.value.set('old',row());f.requests.set(key,controller);f.transcripts.value[key]={messageId:'old',loading:true,visible:true};f.api.reconcileTranscriptViews();assert.equal(controller.signal.aborted,false);assert.equal(f.transcripts.value[key].loading,true);assert.equal(f.reads.length,0);
});
test('reopening a query-only voice reads its existing result without launching recognition',async()=>{
 const f=fixture();f.messages.value.set('old',row());f.api.restoreTranscriptViews();assert.equal(f.reads.length,1);assert.equal(f.transcripts.value[key].loading,true);f.finish('saved original result');await new Promise(r=>setImmediate(r));assert.equal(f.transcripts.value[key].text,'saved original result');assert.equal(f.transcripts.value[key].loading,false);
});
test('hidden, recalled, missing or replaced source clears results and aborts pending observation',()=>{
 for(const state of ['hidden','recalled','missing','replaced']){const f=fixture(),controller=new AbortController();if(state!=='missing')f.messages.value.set('old',row(state==='replaced'?{attachments:[{...attachment,sha256:'new'}]}:{[state]:true}));f.requests.set(key,controller);f.transcripts.value[key]={messageId:'old',text:'private result'};f.api.reconcileTranscriptViews();assert.equal(controller.signal.aborted,true);assert.equal(f.transcripts.value[key],undefined);assert.equal(f.reads.length,0);}
});
test('a canceled or replaced result request cannot restore stale text',async()=>{
 const f=fixture();f.messages.value.set('old',row());f.api.restoreTranscriptViews();f.reads[0].signal.throwIfAborted();f.messages.value.clear();f.api.reconcileTranscriptViews();f.finish('late result');await new Promise(r=>setImmediate(r));assert.equal(f.transcripts.value[key],undefined);
});

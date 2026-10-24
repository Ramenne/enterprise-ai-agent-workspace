import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=readFileSync(new URL('../src/ui/views/ConversationsView.vue',import.meta.url),'utf8');
const code=ts.transpileModule(source.slice(source.indexOf('function loadDrafts()'),source.indexOf('const actions=ref<Row|null>')),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
function setup(load){
 const session={user:{username:'a'}},draftLoadError={value:''},draftLoading={value:false};
 const api=new Function('session','drafts','draftLoadError','draftLoading',`let active=true,epoch=0,draftFlight=null;${code};return {loadDrafts,changeAccount(owner){epoch++;session.user.username=owner;draftFlight=null;draftLoadError.value='';draftLoading.value=false;},deactivate(){active=false;}};`)(session,{load},draftLoadError,draftLoading);
 return {api,error:draftLoadError,busy:draftLoading};
}
test('one shared failed read remains retryable and clears only after a successful read',async()=>{
 let finish,calls=0;const f=setup(()=>{calls++;return new Promise((resolve,reject)=>finish={resolve,reject});});
 const first=f.api.loadDrafts(),second=f.api.loadDrafts();assert.equal(first,second);
 await new Promise(resolve=>setImmediate(resolve));finish.reject(Error('temporary IDB rejection'));await first;
 assert.equal(calls,1);assert.match(f.error.value,/草稿/);assert.equal(f.busy.value,false);
 const retry=f.api.loadDrafts();await new Promise(resolve=>setImmediate(resolve));finish.resolve();await retry;
 assert.equal(calls,2);assert.equal(f.error.value,'');assert.equal(f.busy.value,false);
});
test('late failure from an old account cannot replace current success or busy state',async()=>{
 const gates=new Map(),f=setup(owner=>new Promise((resolve,reject)=>gates.set(owner,{resolve,reject})));
 const old=f.api.loadDrafts();await new Promise(resolve=>setImmediate(resolve));f.api.changeAccount('b');
 const current=f.api.loadDrafts();await new Promise(resolve=>setImmediate(resolve));gates.get('a').reject(Error('old failure'));await old;
 assert.equal(f.error.value,'');assert.equal(f.busy.value,true);
 gates.get('b').resolve();await current;assert.equal(f.error.value,'');assert.equal(f.busy.value,false);
});
test('inactive conversation list does not begin another draft read',async()=>{
 let calls=0;const f=setup(async()=>{calls++;});f.api.deactivate();await f.api.loadDrafts();assert.equal(calls,0);
});

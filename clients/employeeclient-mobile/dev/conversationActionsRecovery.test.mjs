import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=readFileSync(new URL('../src/ui/views/ConversationsView.vue',import.meta.url),'utf8');
const code=ts.transpileModule(source.slice(source.indexOf('async function change('),source.indexOf('onActivated(')),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
function setup({metaSet=async()=>{}}={}){
 const row={peer:'b',pinned:false,message:{id:'old'}},actions={value:row},acting={value:false},actionError={value:''},rows={value:[row]},session={user:{username:'a'}};
 const calls=[],deps={actions,acting,actionError,rows,session,displayRows:{get value(){return rows.value;}},newIdempotencyKey:()=> 'stable-key',communication:{conversationAction:async(body,key)=>{calls.push({body,key});}},metaSet,refresh:async()=>{},data:{syncNotifications:async()=>{}},userError:(_e,fallback)=>fallback};
 const api=new Function(...Object.keys(deps),`let epoch=1,actionGeneration=1,pendingAction;${code};return {change,depart(){actionGeneration++;actions.value=null;pendingAction=undefined;acting.value=false;actionError.value='';},openNew(){actions.value={peer:'c',pinned:false};acting.value=true;actionError.value='new';},pending:()=>pendingAction};`)(...Object.values(deps));
 return {api,calls,deps};
}
test('failed confirmation retries the same action/key and blocks a competing action',async()=>{
 const f=setup();let fail=true;const send=f.deps.communication.conversationAction;f.deps.communication.conversationAction=async(...a)=>{await send(...a);if(fail)throw Error('receipt unavailable');};
 await f.api.change('pin');assert.match(f.deps.actionError.value,/未确认/);assert.equal(f.deps.acting.value,false);
 await f.api.change('clear_preview');assert.equal(f.calls.length,1);
 fail=false;await f.api.change('pin');assert.equal(f.calls.length,2);assert.deepEqual(f.calls[0],f.calls[1]);assert.equal(f.deps.actions.value,null);assert.equal(f.deps.actionError.value,'');
});
test('a late receipt after leaving cannot close or change a new menu',async()=>{
 const f=setup();let release;f.deps.communication.conversationAction=()=>new Promise(resolve=>release=resolve);
 const sending=f.api.change('pin');f.api.depart();f.api.openNew();release();await sending;
 assert.equal(f.deps.actions.value.peer,'c');assert.equal(f.deps.acting.value,true);assert.equal(f.deps.actionError.value,'new');assert.equal(f.deps.rows.value[0].pinned,false);
});
test('a late cache completion after leaving cannot clear the next confirmation',async()=>{
 let release,writeValid;const f=setup({metaSet:(_a,_key,_value,valid)=>{writeValid=valid;return new Promise(resolve=>release=resolve);}});
 const sending=f.api.change('pin');await new Promise(resolve=>setImmediate(resolve));f.api.depart();f.api.openNew();assert.equal(writeValid(),false);release();await sending;
 assert.equal(f.deps.actions.value.peer,'c');assert.equal(f.deps.acting.value,true);assert.equal(f.deps.actionError.value,'new');
});

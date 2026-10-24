import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=readFileSync(new URL('../src/ui/views/ChatView.vue',import.meta.url),'utf8');
const code=ts.transpileModule(source.slice(source.indexOf('async function copySelected()'),source.indexOf('const selectedMessages=')),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
function setup(){
 const ref=value=>({value}),toasts=[],writes=[],gates=[];
 const d={session:{user:{username:'a'}},peer:ref(''),selecting:ref(true),viewActive:ref(true),route:{name:'chat'},selectedMessages:ref([{body:'第一条\n双空格  保留'},{body:'第二条'}]),selectionText:rows=>rows.map(m=>m.body).join('\n\n'),ui:{toast:(...args)=>toasts.push(args)},userError:(_e,text)=>text,stopSelecting:()=>{d.selecting.value=false;},navigator:{clipboard:{writeText:text=>{writes.push(text);return new Promise((resolve,reject)=>gates.push({resolve,reject}));}}}};
 const api=new Function(...Object.keys(d),`let threadGeneration=1,selectionRevision=1;${code};return {copySelected,newSelection(){selectionRevision++;selecting.value=true;},newEntry(){threadGeneration++;},};`)(...Object.values(d));
 return {d,api,toasts,writes,gates};
}
test('copy success closes only the selection that initiated it and preserves text bytes',async()=>{
 const f=setup(),run=f.api.copySelected();assert.equal(f.writes[0],'第一条\n双空格  保留\n\n第二条');f.gates[0].resolve();await run;assert.equal(f.d.selecting.value,false);assert.equal(f.toasts.length,1);
});
test('an old clipboard success cannot clear a new selection in the same conversation',async()=>{
 const f=setup(),run=f.api.copySelected();f.api.newSelection();f.gates[0].resolve();await run;assert.equal(f.d.selecting.value,true);assert.equal(f.toasts.length,0);
});
test('a departed conversation cannot report a stale copy failure after returning',async()=>{
 const f=setup(),run=f.api.copySelected();f.api.newEntry();f.gates[0].reject(Error('old failure'));await run;assert.equal(f.d.selecting.value,true);assert.equal(f.toasts.length,0);
});
test('a current clipboard rejection preserves selection and offers a fresh attempt',async()=>{
 const f=setup(),first=f.api.copySelected();f.gates[0].reject(Error('denied'));await first;assert.equal(f.d.selecting.value,true);assert.equal(f.toasts.length,1);
 const retry=f.api.copySelected();f.gates[1].resolve();await retry;assert.equal(f.d.selecting.value,false);assert.equal(f.writes[1],f.writes[0]);
});

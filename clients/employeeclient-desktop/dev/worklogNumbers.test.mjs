import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { ref } from 'vue';
const transpile = text => ts.transpileModule(text, {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const src = readFileSync(new URL('../src/domain/agentHandoff.ts',import.meta.url),'utf8');
const mod = await import('data:text/javascript;base64,'+Buffer.from(transpile(src)).toString('base64'));
const task = {id:'tsk_test',scope_at_creation:'company',project_id:'v8',latest_worklog_id:1539};
test('copy carries actual existing event numbers, keeps multiple events and does not renumber Task',()=>{
 const context={related_worklogs:[{id:1539,action:'补充',ts:2},{id:1538,action:'提交',ts:1}]};
 const text=mod.agentHandoffInstructions(task,context).join('\n');
 assert.match(text,/#1539 补充/);assert.match(text,/#1538 提交/);
 assert.equal(text.match(/#1539/g).length,1);assert.match(text,/内部任务 ID.*tsk_test/);
 assert.doesNotMatch(text,/动态查询|v8_worklog_list/);
});
test('private or invalid values never create company number labels',()=>{
 for(const value of [null,undefined,0,-1,1.5,'1539',NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) assert.equal(mod.worklogLabel(value),'');
 const text=mod.agentHandoffInstructions({...task,scope_at_creation:'personal'},{related_worklogs:[{id:1539,action:'不应显示'}]}).join('\n');
 assert.doesNotMatch(text,/#1539/);
 assert.deepEqual(mod.taskWorklogLines({...task,latest_worklog_id:null}),[]);
});
const component=readFileSync(new URL('../src/ui/components/RelatedWorklogs.vue',import.meta.url),'utf8');
const js=transpile(component.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]).replace(/^import .*;\r?\n/gm,'');
function setup(fetch,valid=()=>true){
 const props={context:{task,related_worklogs:[{id:1539,action:'补充'}],related_worklogs_next_cursor:'cursor1'},control:false};
 let reset;
 const state=new Function('ref','watch','onBeforeUnmount','defineProps','useDataStore','me','controlApi',js+';return {more,rows,cursor,error};')(
 ref,(_getter,cb)=>{reset=cb;cb(props.context);},()=>{},()=>props,()=>({captureLease:()=>({valid})}),{taskHistory:fetch},{taskHistory:()=>{throw Error('unexpected control access');}});
 return {...state,reset};
}
test('related records paginate real server cursor, deduplicate and preserve older number',async()=>{
 const calls=[];const s=setup(async(...args)=>{calls.push(args);return {kind:'worklogs',items:[{id:1539},{id:1538}],next_cursor:null};});
 await s.more();assert.deepEqual(calls,[[task.id,'worklogs','cursor1']]);assert.deepEqual(s.rows.value.map(x=>x.id),[1539,1538]);assert.equal(s.cursor.value,null);
});
test('late records cannot cross context or account, failed reads preserve cursor',async()=>{
 let done;const s=setup(()=>new Promise(resolve=>done=resolve));const p=s.more();
 s.reset({task,related_worklogs:[{id:2000}],related_worklogs_next_cursor:null});
 done({kind:'worklogs',items:[{id:1538}],next_cursor:null});await p;assert.deepEqual(s.rows.value.map(x=>x.id),[2000]);
 const failed=setup(async()=>{throw Error('network');});await failed.more();assert.equal(failed.cursor.value,'cursor1');assert.ok(failed.error.value);
 const revoked=setup(async()=>({kind:'worklogs',items:[{id:1538}],next_cursor:null}),()=>false);await revoked.more();assert.deepEqual(revoked.rows.value.map(x=>x.id),[1539]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=readFileSync(new URL('../src/ui/views/ChatView.vue',import.meta.url),'utf8');
const code=ts.transpileModule(source.slice(source.indexOf('function cancelViewResume(){'),source.indexOf('function saveViewState(){')),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
function fixture({busy=false,pending=null,error='',ready=false}={}){const controller=new AbortController(),busyRef={value:busy},errorRef={value:error};const run=new Function('viewResumeBusy','pendingViewResume','viewResumeReady','viewResumeError','viewResumeController',code+';return {cancelViewResume,state:()=>({pendingViewResume,viewResumeReady,viewResumeController})};')(busyRef,pending,ready,errorRef,controller);return {run,busyRef,errorRef,controller};}
test('new user intent after a failed restore discards the old pending preference and permits saving the new view',()=>{const f=fixture({pending:{schema:1},error:'503'});f.run.cancelViewResume();assert.equal(f.run.state().pendingViewResume,null);assert.equal(f.run.state().viewResumeReady,true);assert.equal(f.errorRef.value,'');});
test('new intent also replaces a corrupt read preference, while an unrelated save warning stays retryable',()=>{const f=fixture({error:'corrupt'});f.run.cancelViewResume();assert.equal(f.run.state().viewResumeReady,true);const g=fixture({error:'save warning',ready:true});g.run.cancelViewResume();assert.equal(g.errorRef.value,'save warning');});
test('canceling active recovery aborts its response ownership immediately',()=>{const f=fixture({busy:true,pending:{schema:1}});f.run.cancelViewResume();assert.equal(f.controller.signal.aborted,true);assert.equal(f.busyRef.value,false);assert.equal(f.run.state().viewResumeController,null);});

import {readFeedbackFixture} from './readFeedback.fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import {ref,computed,reactive,watch} from 'vue';
import {createHubCache} from '../src/native/hub-cache.mjs';
import {createRecoveryGate} from '../src/platform/recoveryGate.mjs';
import {myProjects} from '../src/native/discovery.mjs';
import {attributeCatalog,filterAttributes,metadataMatches,retainAttributeSelection} from '../src/native/attribute-query.mjs';
const turn=()=>new Promise(r=>setImmediate(r));
const project={project_id:'p',title:'自己的工作',visibility:'personal',owner_id:'a',properties:{attributes:{category:'协作'}}};
const work={work_item_id:'w',short_no:1000133,project_id:'p',goal:'协作事项',type:'work',state:'active',properties:{attributes:{category:'协作'}}};
async function fixture(){
 const db=new Map(),lease={account:'a',epoch:1,valid:()=>true};let time=1;
 const storage={get:async(a,k)=>db.get(a+k),put:async(a,k,v)=>db.set(a+k,structuredClone(v)),remove:async(a,k)=>db.delete(a+k),now:()=>time};
 const prior=createHubCache(storage);
 await prior.read(lease,'projects',async()=>[project]);
 await prior.read(lease,'work:p',async()=>({rows:[{...work,projectProperties:reactive(project).properties}]}));
 time=1000000;
 // A fresh module/cache instance represents an overwrite update or restart.
 const cache=createHubCache(storage);let directoryResolve,directoryReject,workResolve,catalogReads=0;
 const directory=new Promise((r,j)=>{directoryResolve=r;directoryReject=j;});
 const catalog=new Promise(r=>workResolve=r);
 const deps={useReadFeedback:readFeedbackFixture,ref,computed,watch,createRecoveryGate,isRetryableFailure:()=>false,onChatWake:()=>()=>{},useModeBack:()=>{},defineOptions:()=>{},onMounted:()=>{},onBeforeUnmount:()=>{},onDeactivated:()=>{},onActivated:()=>{},onBeforeRouteLeave:()=>{},
  useSessionStore:()=>({onUnauthorized(){}}),useUiStore:()=>({}),useRouter:()=>({}),useRoute:()=>({query:{},fullPath:'/work'}),captureApiLease:()=>lease,
  metaGet:async()=>({project:'p',query:'协作',selected:{},limit:40}),metaSet:async()=>{},
  readProjects:(_l,options)=>cache.read(lease,'projects',()=>directory,options),
  readWorkCatalog:(_l,p,options)=>{catalogReads++;return cache.read(lease,'work:'+p.project_id,()=>catalog,options);},
  myProjects,attributeCatalog,filterAttributes,metadataMatches,retainAttributeSelection,userError:e=>e.message};
 const file=await readFile(new URL('../src/ui/views/WorkHomeView.vue',import.meta.url),'utf8');
 const script=file.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1].replace(/^import[^\n]+\n/gm,'');
 const code=ts.transpileModule(script,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 const view=new Function(...Object.keys(deps),code+';return {load,rows,project,query,selected,projects,busy};')(...Object.values(deps));
 return {view,directoryResolve,directoryReject,workResolve,get catalogReads(){return catalogReads;}};
}
test('restart restores work and saved query before slow directory and work refresh finish',async()=>{
 const f=await fixture(),loading=f.view.load();await turn();
 assert.equal(f.view.rows.value[0]?.short_no,1000133);
 assert.equal(f.view.project.value,'p');assert.equal(f.view.query.value,'协作');
 f.directoryResolve([project]);await turn();assert.equal(f.catalogReads,1,'unchanged directory must not re-run the work load');
 f.workResolve({rows:[{...work,goal:'更新后的协作事项'}]});await loading;
 assert.equal(f.view.rows.value[0].goal,'更新后的协作事项');
});
test('directory denial hides old work and a late refresh cannot put it back',async()=>{
 const f=await fixture(),loading=f.view.load(true);await turn();assert.equal(f.view.rows.value.length,1);
 f.directoryReject(Object.assign(Error('permission revoked'),{status:403}));await loading;
 assert.deepEqual(f.view.rows.value,[]);assert.deepEqual(f.view.projects.value,[]);
 f.workResolve({rows:[work]});await turn();assert.deepEqual(f.view.rows.value,[]);
});

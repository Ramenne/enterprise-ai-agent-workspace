import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {authorizedProjects} from '../src/native/discovery.mjs';
// Execute the actual component loaders. Ports simulate transient source errors.
const source=readFileSync(new URL('../src/ui/components/HubBrowser.vue',import.meta.url),'utf8');
const code=ts.transpileModule(source.slice(source.indexOf('async function loadScope('),source.indexOf('function selectAttribute(')),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
function fixture(){
 const ref=value=>({value}),p={project_id:'p',title:'项目'},calls=[];
 const deps={retainedScroll:null,alive:true,viewReady:false,generation:0,scopeAbort:undefined,retrySource:'projects',lease:{account:'a',valid:()=>true},
  filtersOpen:ref(false),busy:ref(false),error:ref(''),complete:ref(false),truncated:ref(false),props:{mode:'work',onlyProject:'p'},
  projects:ref([]),project:ref(''),visibility:ref(''),query:ref(''),submittedQuery:ref(''),selected:ref({}),windowSize:ref(50),catalogRows:ref([]),searchRows:ref(null),
  scopeOptions:ref([]),session:{user:{username:'a'},onUnauthorized:()=>{}},route:{query:{}},root:ref(null),
  authorizedProjects,retainAttributeSelection:(_rows,selection)=>selection,metaGet:async()=>null,nextTick:async()=>{},scrollHost:()=>null,userError:e=>e.message,
  failDirectory:true,failCatalog:false,search:async()=>{},viewKey:'test-view',emit:()=>{},
 };
 deps.projectChoices={get value(){return deps.projects.value;}};
 deps.targetProjects={get value(){return deps.projects.value.filter(row=>!deps.project.value||row.project_id===deps.project.value);}};
 deps.clearQueryFlight=()=>{deps.searchRows.value=null;};
 deps.readProjects=async(_lease,options)=>{calls.push({source:'projects',force:options.force});if(deps.failDirectory){deps.failDirectory=false;throw Object.assign(Error('network unavailable'),{status:503});}return [p];};
 deps.readCatalog=async(_lease,_project,_mode,options)=>{calls.push({source:'catalog',force:options.force});if(deps.failCatalog){deps.failCatalog=false;throw Object.assign(Error('catalog unavailable'),{status:503});}return {rows:[{work_item_id:'w',project_id:'p'}]};};
 const api=new Function(...Object.keys(deps),code+';return {loadProjects,loadScope,retry};')(...Object.values(deps));
 return {deps,calls,api};
}
test('directory retry actually rereads the directory instead of reporting no accessible projects',async()=>{
 const f=fixture();await f.api.loadProjects();assert.match(f.deps.error.value,/network/);assert.equal(f.deps.projects.value.length,0);
 await f.api.retry();assert.equal(f.deps.error.value,'');assert.equal(f.deps.projects.value.length,1);assert.equal(f.deps.catalogRows.value[0].work_item_id,'w');
 assert.deepEqual(f.calls.map(x=>[x.source,x.force]),[['projects',false],['projects',true],['catalog',true]]);
});
test('catalogue retry keeps the selected project and forces stale cache refresh',async()=>{
 const f=fixture();f.deps.failDirectory=false;f.deps.failCatalog=true;await f.api.loadProjects();assert.match(f.deps.error.value,/catalog/);
 await f.api.retry();assert.equal(f.deps.project.value,'p');assert.equal(f.deps.error.value,'');assert.equal(f.deps.catalogRows.value.length,1);
 assert.deepEqual(f.calls.map(x=>[x.source,x.force]),[['projects',false],['catalog',false],['catalog',true]]);
});
test('retry remains an explicit error while the directory is still unavailable',async()=>{
 const f=fixture();await f.api.loadProjects();f.deps.failDirectory=true;await f.api.retry();assert.match(f.deps.error.value,/network/);assert.equal(f.deps.complete.value,false);assert.equal(f.calls.length,2);
});

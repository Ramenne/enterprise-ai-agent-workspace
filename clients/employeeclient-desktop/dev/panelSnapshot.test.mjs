import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import {ref,computed,watch,nextTick} from 'vue';
import {authorizedProjects,workRow,numberLabel,fileName,propertyRows,projectScopeValue} from '../src/native/discovery.mjs';
import {attributeCatalog,filterAttributes,loadAuthorizedCatalog,metadataMatches,projectScopeOptions,retainAttributeSelection} from '../src/native/attribute-query.mjs';
import {createHubCache} from '../src/native/hub-cache.mjs';
import {createReadFeedback} from '../src/domain/readFeedback.mjs';
import {userError} from '../src/domain/userError.mjs';
async function fixture(){
 const cache=new Map();let fault=0;
 class NativeClient{reset(){}async projects(){return [{project_id:'p',title:'project',visibility:'team'}];}async rpc(){if(fault)throw Object.assign(Error('upstream'),{status:fault});return {items:[{id:'w',short_no:100,goal:'kept work',properties:{attributes:{category:'测试'}}}],coverage:{complete:true}};}}
 const shared=createHubCache({get:async(a,k)=>cache.get(a+':'+k),put:async(a,k,v)=>cache.set(a+':'+k,structuredClone(v)),remove:async(a,k)=>cache.delete(a+':'+k),now:()=>1});
 const readProjects=async()=>new NativeClient().projects();
 const readCatalog=(lease,p,mode,opts)=>shared.read(lease,'catalog:'+p.project_id,()=>loadAuthorizedCatalog(new NativeClient(),p,{mode}),{...opts,force:!!fault});
 const useReadFeedback=()=>{const error=ref('');return {error,feedback:createReadFeedback({publish:text=>error.value=text,setTimer:()=>0,clearTimer:()=>{}})};};
 const deps={onBeforeRouteLeave:()=>{},onActivated:()=>{},useReadFeedback,ref,computed,onMounted:()=>{},onBeforeUnmount:()=>{},onDeactivated:()=>{},watch,nextTick,document:{scrollingElement:null},defineProps:()=>({mode:'work'}),defineEmits:()=>()=>{},useRoute:()=>({query:{project:'p'}}),useRouter:()=>({push(){}}),useUiStore:()=>({closeOverlay(){}}),serviceOrigin:()=>'',useSessionStore:()=>({user:{username:'a'},onUnauthorized(){}}),captureApiLease:()=>({account:'a',valid:()=>true}),NativeClient,readProjects,readCatalog,authorizedProjects,workRow,numberLabel,fileName,propertyRows,projectScopeValue,attributeCatalog,filterAttributes,loadAuthorizedCatalog,metadataMatches,projectScopeOptions,retainAttributeSelection,userError,metaGet:async(_a,k)=>cache.get(k)||null,metaSet:async(_a,k,v)=>cache.set(k,structuredClone(v)),metaRemove:async(_a,k)=>cache.delete(k)};
 const source=(await readFile(new URL('../src/ui/components/HubBrowser.vue',import.meta.url),'utf8')).match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
 const code=ts.transpileModule(source.replace(/^import[^\n]+\n/gm,''),{compilerOptions:{module:ts.ModuleKind.None,target:ts.ScriptTarget.ES2022}}).outputText;
 const setup=new Function(...Object.keys(deps),code+';return {loadProjects,loadScope,search,rows:catalogRows,busy,project,query,submittedQuery,selected,windowSize,saveView};');
 return {view:setup(...Object.values(deps)),reopen:()=>setup(...Object.values(deps)),setFault:s=>fault=s,cache};
}
test('authorized work snapshot survives re-entry and temporary refresh failure',async()=>{const f=await fixture();await f.view.loadProjects();assert.equal(f.view.rows.value[0].work_item_id,'w');f.setFault(503);const next=f.reopen();await next.loadProjects();assert.equal(next.rows.value[0].work_item_id,'w');assert.equal(next.busy.value,false);});
test('explicit read rejection hides and evicts cached work results',async()=>{const f=await fixture();await f.view.loadProjects();f.setFault(403);await f.view.loadScope();assert.deepEqual(f.view.rows.value,[]);assert.equal([...f.cache.keys()].filter(k=>k.includes('hub3:catalog')).length,0);});

test('query attributes, keyword and expanded window restore for the same account',async()=>{const f=await fixture();await f.view.loadProjects();f.view.query.value='kept';f.view.submittedQuery.value='kept';f.view.selected.value={'properties.attributes.category':'"测试"'};f.view.windowSize.value=150;await f.view.saveView();const next=f.reopen();await next.loadProjects();assert.equal(next.query.value,'kept');assert.equal(next.submittedQuery.value,'kept');assert.deepEqual(next.selected.value,{'properties.attributes.category':'"测试"'});assert.equal(next.windowSize.value,150);});

test('old saved fields cannot recreate a dropdown or silently empty current results',async()=>{
 const f=await fixture();await f.view.loadProjects();f.view.selected.value={'properties.attributes.language':'"中文"','sha256':'"old"','properties.attributes.category':'"测试"'};await f.view.saveView();
 const next=f.reopen();await next.loadProjects();assert.deepEqual(next.selected.value,{'properties.attributes.category':'"测试"'});
});

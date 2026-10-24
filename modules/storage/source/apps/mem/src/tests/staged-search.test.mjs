import test from 'node:test';
import assert from 'node:assert/strict';
import {createStagedSearch,rankCandidates,semanticBroker,contains} from '../staged-search.mjs';
import {inspectDescription} from '../description-policy.mjs';
const P='16f05f01-4a43-4e96-a16b-d8ed69eff77d';
function fixture({items=[],vectors=[],properties={},denied=false}={}){
 let calls=[],vectorCalls=0;
 const call=async(token,source,name,action,body)=>{
  assert.equal(token,'same-caller');assert.equal(action,'mem.read');calls.push({name,body});
  if(name==='search_materials')return{items:body.query?items:items.filter(i=>contains(properties[i.material_id]??{},body.properties??{}))};
  if(name==='material_head'){
   if(denied)throw Object.assign(Error('denied'),{code:'42501'});
   const i=[...items,...vectors].find(i=>i.material_id===body.material_id);
   return{fixed_ref:i,placements:[{logical_path:i.logical_path}],properties:properties[i.material_id]??{}};
  }
  if(name==='description_read')return{state:'needs_agent_description',description:null};
  if(name==='material_history')return{items:[{...items[0],created_at:'2026-10-07T00:00:00Z'}]};
  throw Error(name);
 };
 const semantic=async()=>{vectorCalls++;return{state:'queried_candidates',receipt:{items:vectors}}};
 return{search:createStagedSearch({call,semantic,findNumber:async()=>({state:'not_found'})}),calls,vectorCalls:()=>vectorCalls};
}
const item=(n,path,description)=>({material_id:'m'+n,version_id:'v'+n,sha256:'a'.repeat(64),logical_path:path,...(description?{description:{text:description},similarity:0.7}: {})});
test('a broad single attribute result does not stop a free-text question',async()=>{
 const f=fixture({items:[item(1,'irrelevant.md')],vectors:[item(2,'answer.md','明确目标主题')]});
 const r=await f.search('same-caller',undefined,{project_id:P,query:'目标主题',properties:{},limit:10});
 assert.equal(f.vectorCalls(),1);assert.equal(r.stages[0].state,'ambiguous');assert.equal(r.resolution,'needs_selection');
});
test('unique exact filename locates without description or vector invocation',async()=>{
 const f=fixture({items:[item(1,'folder/answer.md')]});
 const r=await f.search('same-caller',undefined,{project_id:P,query:'answer.md'});
 assert.equal(r.resolution,'located');assert.equal(f.vectorCalls(),0);assert.equal(r.items[0].description,null);assert.ok(!f.calls.some(c=>c.name==='description_read'));
});
test('duplicate exact names continue down the hierarchy',async()=>{
 const f=fixture({items:[item(1,'a/answer.md'),item(2,'b/answer.md')]});
 const r=await f.search('same-caller',undefined,{project_id:P,query:'answer.md'});
 assert.equal(f.vectorCalls(),1);assert.equal(r.resolution,'needs_selection');
});
test('hard properties apply to vector candidates too',async()=>{
 const f=fixture({vectors:[item(1,'secret.md','目标'),item(2,'target.md','目标')],properties:{m1:{attributes:{category:'wrong'}},m2:{attributes:{category:'wanted'}}}});
 const r=await f.search('same-caller',undefined,{project_id:P,query:'目标',properties:{attributes:{category:'wanted'}}});
 assert.deepEqual(r.items.map(x=>x.material_id),['m2']);
});
test('unique explicit properties locate with no vector requirement',async()=>{
 const f=fixture({items:[item(1,'new-file.md')],properties:{m1:{attributes:{category:'wanted'}}}});
 const r=await f.search('same-caller',undefined,{project_id:P,properties:{attributes:{category:'wanted'}}});
 assert.equal(r.resolution,'located');assert.equal(r.located_by,'extended_attributes');assert.equal(f.vectorCalls(),0);
});
test('denied candidates are omitted and never returned as stale matches',async()=>{
 const f=fixture({vectors:[item(1,'secret.md','目标')],denied:true});
 const r=await f.search('same-caller',undefined,{project_id:P,query:'目标'});assert.equal(r.items.length,0);
});
test('time bounds apply before deciding exact-name success',async()=>{
 const f=fixture({items:[item(1,'answer.md')]});
 const r=await f.search('same-caller',undefined,{project_id:P,query:'answer.md',version_created_before:'2026-10-01T00:00:00Z'});
 assert.equal(r.resolution,'not_found');assert.equal(f.vectorCalls(),1);
});
test('ranking responds to metadata relevance, no per-file whitelist',()=>{
 const a={...item(1,'old-navigation.md','成员入口导航'),semantic_rank:1};
 const b={...item(2,'文件移动.md','文件移动保持旧版本引用'),semantic_rank:10};
 assert.equal(rankCandidates([a,b],'文件移动旧版本引用')[0].material_id,'m2');
});
test('semantic-prioritized RRF retains the stronger vector vote when two lexical ranks reverse',()=>{
 const good={...item(1,'资料四级分类规则.md','资料等级由内容用途判断'),semantic_rank:1,similarity:0.65};
 const noisy={...item(2,'目录索引.md','资料等级资料读取次数重要性资料用途目录资料分类'),semantic_rank:2,similarity:0.5};
 assert.equal(rankCandidates([noisy,good],'资料读取次数重要性等级')[0].material_id,'m1');
});
test('semantic outage preserves authorized attribute alternatives',async()=>{
 const f=fixture({items:[item(1,'partial.md')]});
 const search=createStagedSearch({call:async(t,s,n,a,b)=>{
  if(n==='search_materials')return{items:[item(1,'partial.md')]};
  if(n==='material_head')return{fixed_ref:item(1,'partial.md'),placements:[{logical_path:'partial.md'}],properties:{}};
  return{description:null};
 },semantic:async()=>({state:'capability_unavailable',error_code:'semantic_dependency_unavailable'}),findNumber:async()=>({})});
 const r=await search('same-caller',undefined,{project_id:P,query:'模糊问题'});
 assert.equal(r.items.length,1);assert.equal(r.stages.at(-1).state,'unavailable');assert.equal(r.resolution,'needs_selection');
});
test('semantic transport uses same bearer and the fixed protected domain route',async()=>{
 let called;
 const provider=semanticBroker({url:'http://127.0.0.1:9999/',fetcher:async(url,options)=>{called={url,options};return new Response(JSON.stringify({state:'queried_candidates',receipt:{items:[]}}))}});
 const r=await provider('same-caller',{provider:'Codex'},{project_id:P,text:'test',top_k:10,mode:'exact'});
 assert.equal(r.state,'queried_candidates');assert.equal(called.options.headers.authorization,'Bearer same-caller');
 assert.equal(called.url.pathname,'/semantic/description-query');assert.deepEqual(JSON.parse(called.options.body).source_context,{provider:'Codex'});assert.equal(called.options.redirect,'error');
});
test('a process status is rejected as an active introduction; drafts remain usable',()=>{
 assert.equal(inspectDescription({text:'已登记。',state:'active'}).valid,false);
 assert.equal(inspectDescription({text:'待补充',state:'draft'}).valid,true);
 assert.equal(inspectDescription({text:'合同约定双方的交付义务和付款条件，供履约核对。',state:'active'}).valid,true);
});

test('unique exact match is reauthorized before early delivery',async()=>{
 let heads=0;
 const search=createStagedSearch({call:async(t,s,n,a,b)=>{
  if(n==='search_materials')return {items:[item(1,'answer.md')]};
  if(n==='material_head'){if(++heads>1)throw Object.assign(Error('revoked'),{status:403});return {fixed_ref:item(1,'answer.md'),placements:[{logical_path:'answer.md'}],properties:{}};}
  throw Error(n);
 },semantic:async()=>{throw Error('exact lookup must not invoke vector');},findNumber:async()=>({})});
 const r=await search('same-caller',undefined,{project_id:P,query:'answer.md'});
 assert.equal(heads,2);assert.equal(r.items.length,0);assert.equal(r.resolution,'not_found');
});
test('final property change removes a unique attribute match',async()=>{
 let heads=0;
 const search=createStagedSearch({call:async(t,s,n)=>{
  if(n==='search_materials')return {items:[item(1,'one.md')]};
  if(n==='material_head')return {fixed_ref:item(1,'one.md'),properties:{category:++heads===1?'wanted':'changed'}};
 },semantic:async()=>{throw Error('no vector');},findNumber:async()=>({})});
 const r=await search('same-caller',undefined,{project_id:P,properties:{category:'wanted'}});
 assert.equal(r.items.length,0);assert.equal(heads,2);
});
test('late denied top result does not discard eligible candidates below the result limit',async()=>{
 const counts=new Map(),items=[item(1,'first.md'),item(2,'second.md')];
 const search=createStagedSearch({call:async(t,s,n,a,b)=>{
  if(n==='search_materials')return {items};
  if(n==='material_head'){
   const count=(counts.get(b.material_id)||0)+1;counts.set(b.material_id,count);
   if(b.material_id==='m1'&&count===2)throw Object.assign(Error('revoked'),{status:403});
   const i=items.find(x=>x.material_id===b.material_id);return {fixed_ref:i,properties:{},placements:[{logical_path:i.logical_path}]};
  }throw Error(n);
 },semantic:async()=>({state:'queried_candidates',receipt:{items:[]}}),findNumber:async()=>({})});
 const r=await search('same-caller',undefined,{project_id:P,query:'unmatched',semantic:false,limit:1});
 assert.deepEqual(r.items.map(x=>x.material_id),['m2']);
});

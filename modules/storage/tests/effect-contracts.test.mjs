import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {gcCommands,objectSchemas,moveScopeSchema,effectInputContracts} from '../source/apps/mem/src/effect-contracts.mjs';
import {registerGC} from '../source/apps/mem/src/gc-flow.js';
import {registerCompensation} from '../source/apps/mem/src/compensation.js';
import {registerScopeMove} from '../source/apps/mem/src/scope-move-flow.js';
import {registerObjectAvailability} from '../source/apps/mem/src/object-availability.js';
import {DomainError} from '../source/packages/platform/src/http.js';
import bundle from '../generated/mcp/mem-input.json' with {type:'json'};
const id='16f05f01-4a43-4e96-a16b-d8ed69eff77d',other='cbd510d3-162f-4a62-a3e3-9648cd067297';
const req=body=>({headers:{authorization:'Bearer synthetic-effect-contract'},body});
const router=()=>{const routes=new Map();return{routes,app:{post:(path,handler)=>routes.set(path,handler)}};};
test('GC target exclusivity and irreversible confirmation remain domain checks before any dispatch',async()=>{
 const {routes,app}=router(),calls=[];registerGC(app,async(...args)=>{calls.push(args);return{state:'planned'};});
 const base={project_id:id,idempotency_key:'synthetic-gc-original'};
 for(const body of [base,{...base,material_id:id,operation_id:other},{...base,operation_id:id,target_version_id:other}])await assert.rejects(routes.get('/v2/materials/gc/plan')(req(body),{}),e=>e.code==='invalid_input');
 for(const command of ['destroy','retry'])await assert.rejects(routes.get('/v2/materials/gc/'+command)(req({project_id:id,plan_id:other}),{}),e=>e.code==='invalid_input');
 assert.equal(calls.length,0);
 await routes.get('/v2/materials/gc/plan')(req({...base,material_id:id,target_version_id:other}),{});
 assert.equal(calls[0][2],'gc_plan');assert.equal(calls[0][3],'mem.delete');assert.deepEqual(calls[0][4],{...base,material_id:id,target_version_id:other});
 let code;const result=await routes.get('/v2/materials/gc/destroy')(req({project_id:id,plan_id:other,irreversible_confirmed:true}),{code:n=>{code=n;return{send:value=>value};}});
 assert.equal(code,503);assert.equal(result.authorization,'not_asserted');assert.equal(calls.length,1);
});
test('GC lease identity and TTL bounds stay in the domain contract',()=>{
 const schema=gcCommands.find(x=>x[0]==='read-lease')[3],base={project_id:id,material_id:id,version_id:other,read_receipt_id:id,command:'renew'};
 assert.deepEqual(schema.parse(base),base);
 for(const body of [{...base,ttl_seconds:4},{...base,ttl_seconds:901},{...base,sha256:'not-a-hash'}])assert.equal(schema.safeParse(body).success,false);
});
test('compensation preserves original child keys and partial success without touching later writes',async()=>{
 const {routes,app}=router(),calls=[];registerCompensation(app,async(_token,_source,name,action,body)=>{calls.push({name,action,body});if(calls.length===2)throw new DomainError('revision_conflict',409);return{state:'compensated',operation_id:body.operation_id};});
 const choices=[id,other].map(operation_id=>({operation_id,action:'mem.write',material_id:id,effect_ids:[other]}));
 const result=await routes.get('/v2/compensations/apply')(req({project_id:id,idempotency_key:'original-key',choices}));
 assert.equal(result.state,'partial');assert.deepEqual(calls.map(x=>x.body.idempotency_key),['original-key:0','original-key:1']);assert.equal(result.items[0].state,'compensated');assert.equal(result.items[1].error_code,'revision_conflict');assert.equal(result.items[1].retained_state,'later_writes_and_prior_successful_items_preserved');
});
test('move scope keeps explicit CAS and rejects invalid revisions before authorization',async()=>{
 const {routes,app}=router();registerScopeMove(app,{},{});
 const body={project_id:id,material_id:id,target_project_id:other,placement_id:id,idempotency_key:'original-key',expected_scope_revision:0,expected_version_id:null,mode:'proposal'};
 assert.deepEqual(moveScopeSchema.parse(body),body);assert.equal(Object.hasOwn(moveScopeSchema.parse(body),'expected_content_revision'),false);
 await assert.rejects(routes.get('/v2/materials/move-scope')(req({...body,expected_scope_revision:-1})),e=>e.code==='invalid_move_scope');
});
test('object repair keeps exclusive source selection and explicit fixed-version proof',async()=>{
 const {routes,app}=router(),calls=[];registerObjectAvailability(app,{mode:'real'},async(...args)=>{calls.push(args);return{state:'observed',operation_id:other};});
 const base={project_id:id,material_id:id,version_id:other,idempotency_key:'original-probe'};
 const source_ref={project_id:id,material_id:id,version_id:other},fixed_copy={provider:'s3-compatible',bucket:'synthetic',key:'final/'+id,version_id:'fixed-version'};
 for(const body of [base,{...base,source_ref,fixed_copy},{...base,fixed_copy:{...fixed_copy,version_id:'null'}}])await assert.rejects(routes.get('/v2/objects/repair')(req(body)),e=>e.code==='invalid_input');
 assert.equal(calls.length,0);await routes.get('/v2/objects/probe')(req(base));assert.equal(calls[0][2],'object_probe_prepare');assert.deepEqual(calls[0][4],{...base,command:'probe'});
 assert.equal(objectSchemas.import_copy.safeParse({...base,source_ref}).success,true);
});
test('published effect input views retain original intent while domain refinements remain authoritative',()=>{
 assert.equal(effectInputContracts.length,11);
 for(const path of ['/v2/objects/probe','/v2/materials/move-scope']){
  const record=bundle.contracts.find(x=>x.path===path);assert.equal(record.origin.path,'source/apps/mem/src/effect-contracts.mjs');
  const body=path.endsWith('probe')?{project_id:id,material_id:id,version_id:other,idempotency_key:'original'}:{project_id:id,material_id:id,target_project_id:other,placement_id:id,idempotency_key:'original',expected_version_id:null};
  assert.deepEqual(z.fromJSONSchema(record.input_schema).parse(body),body);
 }
});

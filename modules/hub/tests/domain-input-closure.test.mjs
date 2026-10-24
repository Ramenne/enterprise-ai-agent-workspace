import test from 'node:test';import assert from 'node:assert/strict';
import {inputFor,businessInput,domainMinimumFor,domainOriginFor} from '../dist/contract-check/apps/mcp/src/schemas.js';
const project_id='16f05f01-4a43-4e96-a16b-d8ed69eff77d',id='cbd510d3-162f-4a62-a3e3-9648cd067297';
test('branch presentations allow both actual forms without injecting unrelated fields',()=>{
 const external={project_id,provider_target_id:'synthetic',resource_selector:{version:1,kind:'project'},idempotency_key:'original'};
 const ordinary={project_id,version_id:id,output_hash:'a'.repeat(64),actual_source_closure:[],audience_project_id:id,excluded_content:[],scope:'synthetic',reshare_conditions:'none',reason:'synthetic',continued_source_access:'required',idempotency_key:'original'};
 for(const body of[external,ordinary])for(const input of[body,{payload:body},{...body,payload:body}])assert.deepEqual(businessInput(inputFor('mem.disclosure.create').parse(input)),body);
 assert.ok(!domainMinimumFor('mem.disclosure.create').includes('provider_target_id'));assert.ok(!domainMinimumFor('mem.disclosure.create').includes('version_id'));
 assert.equal(domainOriginFor('mem.disclosure.create').path,'source/apps/mem/src/external-model-contracts.mjs');
 for(const body of[{project_id,job_id:id},{project_id,input:{material_id:id,version_id:id,sha256:'a'.repeat(64)},provider_target_id:'synthetic'}])assert.deepEqual(businessInput(inputFor('mem.asr.start').parse(body)),body);
});
test('search raw text and optional change limit preserve caller intent across envelopes',()=>{
 for(const[name,body]of[['mem.search',{project_id,query:' '.repeat(250)+' word ',semantic:false}],['hub.changes',{project_id,cursor:id}],['mem.material_equivalence.create',{project_id,mode:'proposal',idempotency_key:'original'}]])for(const input of[body,{payload:body},{...body,payload:body}])assert.deepEqual(businessInput(inputFor(name).parse(input)),body);
 assert.equal(domainOriginFor('hub.changes').path,'packages/platform/src/change-contracts.ts');
 assert.throws(()=>businessInput(inputFor('hub.changes').parse({project_id,cursor:id,payload:{project_id,cursor:project_id}})),/mixed_input_conflict/);
});

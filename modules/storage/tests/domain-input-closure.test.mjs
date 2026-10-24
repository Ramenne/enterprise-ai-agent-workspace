import test from 'node:test';import assert from 'node:assert/strict';
import {searchSchemas,searchInputContracts} from '../source/apps/mem/src/search-contracts.mjs';
import {registerExternalModel} from '../source/apps/mem/src/external-model-flow.js';
import {registerVectorFlow} from '../source/apps/mem/src/vector-flow.js';
import {registerEquivalenceFlow} from '../source/apps/mem/src/equivalence-flow.js';
import {registerGovernanceFlow} from '../source/apps/mem/src/governance-flow.js';
import {changeSchemas,changeInputSchemas} from '../source/packages/platform/src/change-contracts.js';
const project_id='16f05f01-4a43-4e96-a16b-d8ed69eff77d',id='cbd510d3-162f-4a62-a3e3-9648cd067297';
const req=body=>({body,headers:{authorization:'Bearer synthetic-domain-contract'}});
test('search normalization stays after raw transport and before normalized bounds',()=>{
 const raw={project_id,query:' '.repeat(250)+' word ',semantic:false};
 assert.deepEqual(searchInputContracts[0][1].parse(raw),raw);assert.equal(searchSchemas.ordinary.parse(raw).query,'word');
 assert.equal(searchSchemas.ordinary.safeParse({project_id,query:'x'.repeat(201)}).success,false);
 assert.equal(searchSchemas.ordinary.safeParse({project_id,properties:{x:'a'.repeat(16384)}}).success,false);
 const named={project_id,name:' '.repeat(250)+' exact '};assert.deepEqual(searchInputContracts[1][1].parse(named),named);assert.equal(searchSchemas.advanced.parse(named).name,'exact');
 assert.equal(searchSchemas.advanced.safeParse({project_id}).success,false);
});
test('ASR start retains prepare-versus-existing selection and never creates a second job for an ID',async()=>{
 const routes=new Map(),calls=[],app={post:(p,fn)=>routes.set(p,fn)};
 registerExternalModel(app,{},async(_t,_s,name,_a,b)=>{calls.push({name,b});return name==='external_recipe'?{state:'existing',job:{run_id:id}}:{state:'scope_needed',job_id:id};},{});
 await routes.get('/v2/asr/start')(req({project_id,job_id:id}));assert.deepEqual(calls.map(x=>x.name),['external_check']);assert.equal(calls[0].b.run_id,id);
 calls.length=0;await routes.get('/v2/asr/start')(req({project_id,input:{material_id:id,version_id:id,sha256:'a'.repeat(64)},provider_target_id:'synthetic',idempotency_key:'original'}));assert.deepEqual(calls.map(x=>x.name),['external_recipe','external_check']);
 calls.length=0;await assert.rejects(routes.get('/v2/asr/start')(req({project_id,job_id:id,input:{material_id:id}})),e=>e.code==='invalid_input');assert.equal(calls.length,0);
});
test('compatibility vector registration remains disabled before input validation',async()=>{
 const routes=new Map();let calls=0;registerVectorFlow({post:(p,fn)=>routes.set(p,fn)},async()=>{calls++;});
 await assert.rejects(routes.get('/v2/materials/vector-index')(req({})),e=>e.code==='legacy_fulltext_vector_index_disabled_use_Agent_description');assert.equal(calls,0);
});
test('equivalence mutation default and original key stay in domain; invalid governance window retains its error',async()=>{
 const routes=new Map(),calls=[];const app={post:(p,fn)=>routes.set(p,fn)},call=async(_t,_s,name,_a,b)=>{calls.push({name,b});return{state:'recorded'};};registerEquivalenceFlow(app,call);registerGovernanceFlow(app,call);
 await routes.get('/v2/material-equivalences')(req({project_id,mode:'proposal',idempotency_key:'original'}),{code:()=>{}});assert.equal(calls[0].b.expected_alias_revision,0);assert.equal(calls[0].b.idempotency_key,'original');
 await assert.rejects(routes.get('/v2/governance/fields')(req({project_id,window_start:'2026-01-02T00:00:00Z',window_end:'2026-01-01T00:00:00Z'})),e=>e.code==='invalid_usage_window');assert.equal(calls.length,1);
});
test('change cursor inputs share rules but transport never supplies the domain default',()=>{
 const raw={project_id,cursor:id};assert.deepEqual(changeInputSchemas.poll.parse(raw),raw);assert.equal(changeSchemas.poll.parse(raw).limit,100);
 assert.equal(changeSchemas.poll.safeParse({...raw,limit:501}).success,false);assert.equal(changeSchemas.snapshot.safeParse({...raw}).success,false);
});

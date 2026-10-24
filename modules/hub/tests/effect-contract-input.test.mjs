import test from 'node:test';
import assert from 'node:assert/strict';
import {inputFor,businessInput,domainOriginFor,domainMinimumFor} from '../dist/contract-check/apps/mcp/src/schemas.js';
const id='16f05f01-4a43-4e96-a16b-d8ed69eff77d',other='cbd510d3-162f-4a62-a3e3-9648cd067297';
const bodies={
 'mem.material.move_scope':{project_id:id,material_id:id,target_project_id:other,placement_id:id,expected_scope_revision:0,expected_version_id:null,idempotency_key:'original-move'},
 'mem.compensation.apply':{project_id:id,idempotency_key:'original-compensation',choices:[{operation_id:other,action:'mem.write',material_id:id,effect_ids:[other]}]},
 'mem.object.probe':{project_id:id,material_id:id,version_id:other,idempotency_key:'original-probe'},
 'mem.gc.plan':{project_id:id,material_id:id,target_version_id:other,idempotency_key:'original-plan'},
 'mem.gc.destroy':{project_id:id,plan_id:other,irreversible_confirmed:true}
};
test('effect input publication preserves explicit original keys, CAS and targets in direct and wrapped forms',()=>{
 for(const[name,b]of Object.entries(bodies)){
  assert.equal(domainOriginFor(name).path,'source/apps/mem/src/effect-contracts.mjs');
  for(const input of [b,{payload:b},{...b,payload:b}])assert.deepEqual(businessInput(inputFor(name).parse(input)),b);
 }
 assert.throws(()=>businessInput(inputFor('mem.object.probe').parse({...bodies['mem.object.probe'],payload:{...bodies['mem.object.probe'],version_id:id}})),/mixed_input_conflict/);
});
test('confirmation, target bounds and source requirements come from the same domain description',()=>{
 assert.equal(inputFor('mem.gc.destroy').safeParse({...bodies['mem.gc.destroy'],irreversible_confirmed:false}).success,false);
 assert.equal(inputFor('mem.material.move_scope').safeParse({...bodies['mem.material.move_scope'],expected_scope_revision:-1}).success,false);
 assert.deepEqual(domainMinimumFor('mem.gc.destroy'),['project_id','plan_id','irreversible_confirmed']);
 assert.ok(domainMinimumFor('mem.object.probe').includes('idempotency_key'));
});

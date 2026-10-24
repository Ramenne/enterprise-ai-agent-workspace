import test from 'node:test';
import assert from 'node:assert/strict';
import {inputFor,businessInput,domainOriginFor,domainMinimumFor} from '../dist/contract-check/apps/mcp/src/schemas.js';
const project_id='16f05f01-4a43-4e96-a16b-d8ed69eff77d',operation_id='cbd510d3-162f-4a62-a3e3-9648cd067297';
test('upload transport derives body plus path field without changing original keys or envelopes',()=>{
 const cases={
  'mem.multipart.begin':{project_id,operation_id,part_size:5242880},
  'mem.multipart.part_ticket':{project_id,operation_id,part_number:1,size:1},
  'mem.multipart.resume':{project_id,operation_id},
  'mem.archive.publish':{project_id,operation_id,expected_project_revision:1,expected_owner_id:project_id,attempt:1,fencing_token:operation_id},
  'mem.gc.inspect':{project_id}
 };
 for(const[name,body]of Object.entries(cases)){
  assert.equal(domainOriginFor(name).path,'source/apps/mem/src/upload-contracts.mjs');
  for(const input of [body,{payload:body},{...body,payload:body}])assert.deepEqual(businessInput(inputFor(name).parse(input)),body);
 }
 const body={project_id,operation_id,part_size:5242880,idempotency_key:'original-上传-key'};
 assert.deepEqual(businessInput(inputFor('mem.multipart.begin').parse(body)),body);
 assert.throws(()=>businessInput(inputFor('mem.multipart.begin').parse({...body,payload:{...body,operation_id:project_id}})),/mixed_input_conflict/);
});
test('help minimum fields and bounds come from the same domain definition',()=>{
 assert.deepEqual(new Set(domainMinimumFor('mem.multipart.begin')),new Set(['project_id','operation_id','part_size']));
 assert.deepEqual(new Set(domainMinimumFor('mem.archive.publish')),new Set(['project_id','operation_id','expected_project_revision','expected_owner_id']));
 for(const part_size of [5242879,5368709121])assert.equal(inputFor('mem.multipart.begin').safeParse({project_id,operation_id,part_size}).success,false);
 assert.equal(inputFor('mem.multipart.part_ticket').safeParse({project_id,operation_id,part_number:10001,size:1}).success,false);
 assert.equal(inputFor('mem.archive.publish').safeParse({project_id,operation_id,expected_project_revision:0,expected_owner_id:project_id}).success,false);
});

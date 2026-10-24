import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {platformFailure,infrastructureFailure,domainErrorCode} from '../packages/platform/src/failure-contract.mjs';
const error=(code,message=code)=>Object.assign(new Error(message),{code});
test('authentication rejection differs from authorization and stale resource handle',()=>{
 assert.equal(platformFailure(error('42501','unauthenticated')).status,401);
 for(const reason of ['missing action','stale_handle','resource_scope_denied'])assert.equal(platformFailure(error('42501',reason)).status,403);
});
test('transient dependency diagnostics distinguish locks and cancellation without exposing SQL',()=>{
 for(const [code,category] of [['55P03','lock_unavailable'],['57014','query_cancelled']]){
  const r=platformFailure(error(code,'SQL with SYNTHETIC_PRIVATE_VALUE'),{requestId:'trace'});
  assert.equal(r.status,503);assert.equal(r.body.error_code,'dependency_busy');assert.equal(r.body.retryable,true);assert.equal(r.body.next_step,'retry_same_request');assert.equal(r.diagnostic.cause_category,category);assert.equal(r.body.request_id,'trace');assert.ok(!JSON.stringify(r).includes('SYNTHETIC_PRIVATE_VALUE'));
 }
});
test('explicit domain errors retain their status, retry semantics and recovery instructions',()=>{
 for(const [code,status,retryable,next_step] of [['restore_required',409,false,'request_mem.object.restore_then_query_same_operation'],['unknown_effect',202,false,'inspect_error'],['dependency_busy',503,true,'retry_same_request']]){
  const r=platformFailure(Object.assign(error(code),{status,retryable}),{explicit:true});assert.equal(r.status,status);assert.equal(r.body.error_code,code);assert.equal(r.body.retryable,retryable);assert.equal(r.body.next_step,next_step);
 }
});
test('SQL conflicts, fixed object states and unexpected failures keep contract',()=>{
 for(const [e,status,code] of [[error('23505'),409,'conflict'],[error('40001'),409,'revision_conflict'],[error('H2410','fixed_object_destroyed'),410,'fixed_object_destroyed'],[error('H2409','fixed_object_sealed_unavailable'),409,'fixed_object_sealed_unavailable'],[new Error('private raw failure'),500,'internal_error']]){const r=platformFailure(e);assert.equal(r.status,status);assert.equal(r.body.error_code,code);}
 assert.equal(infrastructureFailure(error('23505')),null);
 assert.equal(domainErrorCode('expected_revision_required','invalid_input'),'expected_revision_required');assert.equal(domainErrorCode('invalid SQL private data','invalid_input'),'invalid_input');
});
test('distributed copy matches its canonical source digest',async()=>{
 const source=new URL('../packages/platform/src/failure-contract.mjs',import.meta.url),origin=JSON.parse(await readFile(new URL('../packages/platform/src/failure-contract.origin.json',import.meta.url),'utf8'));
 assert.equal(createHash('sha256').update(await readFile(source)).digest('hex'),origin.sha256);assert.equal(origin.project,'fbe863aa-824f-4688-a24d-bc3398754704');assert.equal(origin.path,'packages/platform/src/failure-contract.mjs');
});

test('domain permission aliases cannot override invalid identity or dependency semantics',()=>{
 assert.equal(infrastructureFailure(error('42501','unauthenticated'),{permissionCode:'manager_required'}).code,'unauthenticated');
 const denied=infrastructureFailure(error('42501','manager_required'),{permissionCode:'manager_required'});assert.equal(denied.code,'manager_required');assert.equal(denied.status,403);
 assert.equal(infrastructureFailure(error('42501','SQL private value'),{permissionCode:'SQL private value'}).code,'forbidden');
 assert.equal(infrastructureFailure(error('57014'),{permissionCode:'manager_required'}).code,'dependency_busy');
});

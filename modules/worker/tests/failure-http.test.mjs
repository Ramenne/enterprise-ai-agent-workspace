import test from 'node:test';import assert from 'node:assert/strict';
import {server,DomainError} from '../dist/packages/platform/src/http.js';
test('compiled HTTP handler applies shared policy without exposing raw failures',async t=>{
 const app=server('failure-contract-test');t.after(()=>app.close());let failure;
 app.get('/probe',async()=>{throw failure;});
 for(const [code,message,status,expected] of [['42501','unauthenticated',401,'unauthenticated'],['42501','missing capability',403,'forbidden'],['55P03','private SQL',503,'dependency_busy'],['57014','private SQL',503,'dependency_busy'],['23505','private constraint',409,'conflict']]){
  failure=Object.assign(Error(message),{code});const r=await app.inject({url:'/probe'});assert.equal(r.statusCode,status);assert.equal(r.json().error_code,expected);assert.ok(r.json().request_id);assert.ok(!r.body.includes('private'));
 }
 failure=new DomainError('restore_required',409,false);const r=await app.inject({url:'/probe'});assert.equal(r.statusCode,409);assert.equal(r.json().next_step,'request_mem.object.restore_then_query_same_operation');
});

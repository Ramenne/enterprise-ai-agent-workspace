import test from 'node:test';import assert from 'node:assert/strict';import Fastify from 'fastify';
import {installTaskPoints,installMemberWork} from '../apps/v8/src/task-points.mjs';
import {installProjectFeedback} from '../apps/v8/src/project-feedback.mjs';
const project_id='ab817207-5829-4429-a165-bf1159ae4de0',member_id='46b19322-b0f9-490c-ad90-47989799fd74';
async function fixture(t){const app=Fastify();let failure;const pool={query:async()=>{throw failure;}};installTaskPoints(app,pool);installMemberWork(app,pool,async()=>{throw failure;});installProjectFeedback(app,pool);t.after(()=>app.close());return{set:e=>failure=e,invoke:(url,payload)=>app.inject({method:'POST',url,payload,headers:{authorization:'Bearer SYNTHETIC_NOT_A_CREDENTIAL'}})};}
const paths=[['/v2/board/tasks/lookup',{}],['/v2/member-work/list',{}],['/v2/project-feedback/query',{project_id}],['/v2/points/member-balance',{member_id}]];
test('every direct SQL adapter distinguishes invalid identity, denied permission and dependency failure',async t=>{
 const f=await fixture(t);
 for(const [code,message,status,expected] of [['42501','unauthenticated',401,'unauthenticated'],['42501','stale_handle',403,'forbidden'],['55P03','SQL-private',503,'dependency_busy'],['57014','SQL-private',503,'dependency_busy']]){
  f.set(Object.assign(Error(message),{code}));
  for(const [url,payload] of paths){const r=await f.invoke(url,payload);assert.equal(r.statusCode,status,url);assert.equal(r.json().error_code,url.includes('member-balance')&&expected==='forbidden'?'member_balance_forbidden':expected);assert.ok(!r.body.includes('SQL-private'));}
 }
});
test('business conflicts and receipt correction guidance remain domain specific',async t=>{
 const f=await fixture(t);f.set(Object.assign(Error('revision_conflict'),{code:'40001'}));let r=await f.invoke('/v2/board/tasks/lookup',{});assert.equal(r.statusCode,409);assert.equal(r.json().error_code,'revision_conflict');
 f.set(Object.assign(Error('duplicate'),{code:'23505'}));r=await f.invoke('/v2/project-feedback/query',{project_id});assert.equal(r.statusCode,409);assert.equal(r.json().error_code,'idempotency_conflict');
 r=await f.invoke('/v2/board/receipts/save',{});assert.equal(r.statusCode,400);assert.ok(r.json().receipt_guidance);
 f.set(Object.assign(Error('invalid SQL includes SYNTHETIC_PRIVATE'),{code:'22023'}));r=await f.invoke('/v2/project-feedback/query',{project_id});assert.equal(r.statusCode,400);assert.equal(r.json().error_code,'invalid_input');assert.ok(!r.body.includes('SYNTHETIC_PRIVATE'));
});

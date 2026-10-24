import test from 'node:test';import assert from 'node:assert/strict';
import {startASRWithRecovery} from '../server/asr-recovery.mjs';
const source={material_id:'m',version_id:'v',sha256:'a'.repeat(64)};
const job={project_id:'p',job_id:'original'};
const status={state:'continuation_authorized',technical_state:'prepared',dispatch_state:'prepared',send_authorized:true,input_fixed_ref:source,attempt:1};
const expired={run_id:'original',semantic_kind:'asr_transcription',technical_state:'prepared',revision:3,attempt:1,lease_until:'2000-01-01T00:00:00Z',inputs:[source],outputs:[]};
test('expired unsent run resumes original revision, rechecks authority, sends once',async()=>{
 const calls=[];let reads=0;const result=await startASRWithRecovery(job,{key:'old',call:async(action,body,key)=>{
  calls.push({action,body,key});
  if(action==='status')return {...status,attempt:++reads};
  if(action==='processing.query')return expired;
  if(action==='processing.resume')return {run_id:'original',attempt:2};
  return {state:'known'};
 }});
 assert.equal(result.state,'known');assert.deepEqual(calls.map(c=>c.action),['status','processing.query','processing.resume','status','start']);
 assert.equal(calls[2].body.expected_revision,3);assert.equal(calls[2].body.run_id,'original');assert.equal(calls[2].body.reclaim,undefined);assert.equal(calls[4].body.job_id,'original');assert.equal(calls[4].key,'qn-asr-start:original:2');
});
test('completed, known or unknown dispatch only attaches, never resumes or sends',async()=>{
 for(const v of [{technical_state:'succeeded'}, {intent_id:'consumed',technical_state:'prepared'},{state:'submission_unknown'},{dispatch_state:'unknown'}]){
  const calls=[];await startASRWithRecovery(job,{call:async action=>{calls.push(action);return v;}});assert.deepEqual(calls,['status']);
 }
});
test('changed input, hidden input, wrong run and revoked authority cannot recover or send',async()=>{
 for(const changed of [{...expired,inputs:[{...source,version_id:'other'}]},{...expired,reference_access:{hidden_inputs:1}},{...expired,run_id:'other'},{...expired,outputs:[source]}]){
  const calls=[];await assert.rejects(startASRWithRecovery(job,{call:async action=>{calls.push(action);return action==='status'?status:changed;}}));assert.deepEqual(calls,['status','processing.query']);
 }
 let reads=0,starts=0;await assert.rejects(startASRWithRecovery(job,{call:async action=>{
  if(action==='status')return ++reads===1?status:{...status,attempt:2,send_authorized:false};
  if(action==='processing.query')return expired;if(action==='processing.resume')return {run_id:'original',attempt:2};starts++;return {};
 }}),e=>e.code==='asr_send_not_authorized');assert.equal(starts,0);
});
test('live attempt starts without reclaim; concurrent recovery conflict never retries blindly',async()=>{
 const calls=[];await startASRWithRecovery(job,{key:'same',call:async(action,body,key)=>{
  calls.push({action,key});return action==='status'?status:action==='processing.query'?{...expired,lease_until:'2099-01-01T00:00:00Z'}:{state:'known'};
 }});assert.deepEqual(calls.map(c=>c.action),['status','processing.query','start']);assert.equal(calls[2].key,'qn-asr-start:original:1');
 let starts=0;await assert.rejects(startASRWithRecovery(job,{call:async action=>{
  if(action==='status')return status;if(action==='processing.query')return expired;if(action==='processing.resume')throw Object.assign(Error('conflict'),{code:'revision_conflict'});starts++;return {};
 }}),/conflict/);assert.equal(starts,0);
});

test('actual hub prepared dispatch starts; unknown dispatch only attaches',async()=>{
 const calls=[];await startASRWithRecovery(job,{call:async action=>{calls.push(action);return action==='status'?{...status,state:'authorized',intent_id:null,permit_id:null,provider_task_id:null}:action==='processing.query'?{...expired,lease_until:'2099-01-01T00:00:00Z'}:{state:'known'};}});assert.deepEqual(calls,['status','processing.query','start']);
 const attached=[];await startASRWithRecovery(job,{call:async action=>{attached.push(action);return {...status,dispatch_state:'future_unknown'};}});assert.deepEqual(attached,['status']);
});

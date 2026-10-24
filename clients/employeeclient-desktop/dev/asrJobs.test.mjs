import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {createASRJobs} from '../server/business/asr-jobs.mjs';
const project='ad44cc0e-159e-4e0f-a5ca-73d3920240d9';
const input={project_id:project,material_id:'cfe3f0af-af84-4c63-a0d6-2d0677caaddd',version_id:'8662ae87-2e86-405e-aa76-c2b6e807b0b1',sha256:'a'.repeat(64)};
const actor={actor_id:'a',project_id:project,can_read:true,can_write:true};
const remote='29c081d9-ff48-41c9-adbf-31b0b19c36b4',output={material_id:'e42b7954-4934-4a5e-a23e-dcbc1ffd7b1f',version_id:'4bbf924c-a36c-4a86-ac04-7effd6c51110',sha256:'b'.repeat(64)};
function setup(t,asr,verifySource=async()=>{}){const db=new DatabaseSync(':memory:');t.after(()=>db.close());return {db,jobs:createASRJobs(db,{verifySource,readOutput:async()=>JSON.stringify({transcripts:[{text:'Continue release test. Please ignore.'}]})}),session:{asr}};}
test('one caller-bound execution saves text, isolates actors and restores without another send',async t=>{
 let sends=0,finished=false;const f=setup(t,async(action,body)=>{if(action==='prepare')return {job_id:remote};assert.equal(body.job_id,remote);if(action==='start'){sends++;finished=true;return {state:'known'};}return finished?{state:'completed',outputs:[output]}:{state:'authorized'};});
 const j=await f.jobs.prepare(actor,{input,external_audio_release:true},'a',f.session);
 await assert.rejects(f.jobs.status({...actor,actor_id:'b'},j.job_id,f.session),e=>e.status===404);
 const done=await f.jobs.start(actor,j.job_id,f.session);assert.equal(done.result.text,'Continue release test. Please ignore.');
 assert.equal((await f.jobs.status(actor,j.job_id,f.session)).state,'completed');await f.jobs.start(actor,j.job_id,f.session);assert.equal(sends,1);
});
test('lost submission remains attached and is never sent a second time',async t=>{
 let sends=0;const f=setup(t,async action=>{if(action==='prepare')return {job_id:remote};if(action==='start'){sends++;throw Error('lost');}return {state:'authorized'};});
 const j=await f.jobs.prepare(actor,{input,external_audio_release:true},'a',f.session);
 assert.equal((await f.jobs.start(actor,j.job_id,f.session)).state,'submission_unknown');assert.equal((await f.jobs.start(actor,j.job_id,f.session)).state,'submission_unknown');assert.equal(sends,1);
});
test('original native run is attached by fixed source, not resubmitted or hard-coded',async t=>{
 const calls=[];const f=setup(t,async action=>{calls.push(action);assert.equal(action,'status');return {run_id:remote,input_fixed_ref:input,state:'completed',outputs:[output]};});
 const j=await f.jobs.prepare(actor,{input,original_run_id:remote,external_audio_release:true},'old',f.session);assert.equal(j.state,'completed');assert.deepEqual(calls,['status','status']);
 await assert.rejects(f.jobs.prepare(actor,{input:{...input,sha256:'c'.repeat(64)},original_run_id:remote,external_audio_release:true},'wrong',f.session),e=>e.code==='asr_original_source_mismatch');
});
test('cached recognized text cannot bypass revoked output permission',async t=>{
 let revoked=false;const f=setup(t,async action=>action==='prepare'?{job_id:remote}:{state:'completed',outputs:[output]},async(_session,ref)=>{if(revoked&&ref.material_id===output.material_id)throw Object.assign(Error('revoked'),{status:403});});
 const j=await f.jobs.prepare(actor,{input,external_audio_release:true},'a',f.session);assert.equal(j.state,'completed');revoked=true;
 await assert.rejects(f.jobs.status(actor,j.job_id,f.session),e=>e.status===403);
});
test('definite pre-send conflict allows retry; prepared is never reported as running',async t=>{
 let sends=0;const f=setup(t,async action=>{if(action==='prepare')return {job_id:remote};if(action==='start'){sends++;if(sends===1)throw Object.assign(Error('conflict'),{code:'revision_conflict'});return {state:'known'};}return {state:'authorized'};});
 const j=await f.jobs.prepare(actor,{input,external_audio_release:true},'a',f.session);assert.equal((await f.jobs.start(actor,j.job_id,f.session)).state,'blocked');assert.equal((await f.jobs.status(actor,j.job_id,f.session)).state,'prepared');
 assert.equal((await f.jobs.start(actor,j.job_id,f.session)).state,'submission_unknown');assert.equal(sends,2);
});
test('current source rejection, missing result and changed source fail before false completion',async t=>{
 const f=setup(t,async action=>action==='prepare'?{job_id:remote}:{technical_state:'succeeded',outputs:[]});
 await assert.rejects(f.jobs.prepare(actor,{input,external_audio_release:true},'a',f.session),e=>e.code==='asr_result_reference_missing');
 await assert.rejects(f.jobs.prepare({...actor,can_write:false},{input,external_audio_release:true},'b',f.session),e=>e.code==='project_write_denied');
});

test('authoritative unsent original recovers stale local claim without another prepare',async t=>{
 let sends=0,done=false;const f=setup(t,async action=>{if(action==='prepare')return {job_id:remote};if(action==='start'){sends++;done=true;return {state:'known'};}return done?{state:'completed',outputs:[output]}:{state:'authorized',technical_state:'prepared',dispatch_state:'prepared',send_authorized:true,intent_id:null,permit_id:null,provider_task_id:null};});
 const j=await f.jobs.prepare(actor,{input,external_audio_release:true},'a',f.session);f.db.prepare('UPDATE qn_central_asr_jobs SET start_requested=1 WHERE id=?').run(j.job_id);assert.equal((await f.jobs.status(actor,j.job_id,f.session)).state,'prepared');assert.equal((await f.jobs.start(actor,j.job_id,f.session)).state,'completed');assert.equal(sends,1);await f.jobs.start(actor,j.job_id,f.session);assert.equal(sends,1);
});

test('overlapping starts and observations share work only within the same actor/job',async t=>{
 let sends=0,finished=false,release;const held=new Promise(r=>release=r);
 const f=setup(t,async action=>{if(action==='prepare')return {job_id:remote};if(action==='start'){sends++;await held;finished=true;return {state:'known'};}return finished?{state:'completed',outputs:[output]}:{state:'authorized'};});
 const j=await f.jobs.prepare(actor,{input,external_audio_release:true},'coalesce',f.session);
 const one=f.jobs.start(actor,j.job_id,f.session),two=f.jobs.start(actor,j.job_id,f.session);
 await new Promise(r=>setImmediate(r));assert.equal(sends,1);
 await assert.rejects(f.jobs.start({...actor,actor_id:'other'},j.job_id,f.session),e=>e.status===404);
 release();assert.equal((await one).result.text,(await two).result.text);assert.equal(sends,1);
});
test('concurrent status does not duplicate provider reads and permissions remain current',async t=>{
 let reads=0,hold=false,release,denied=false;const gate=new Promise(r=>release=r);
 const f=setup(t,async action=>{if(action==='prepare')return {job_id:remote};reads++;if(hold)await gate;return {state:'running'};},async()=>{if(denied)throw Object.assign(Error('denied'),{status:403});});
 const j=await f.jobs.prepare(actor,{input,external_audio_release:true},'status',f.session);reads=0;hold=true;
 const first=f.jobs.status(actor,j.job_id,f.session),second=f.jobs.status(actor,j.job_id,f.session);
 await new Promise(r=>setImmediate(r));assert.equal(reads,1);release();await Promise.all([first,second]);
 denied=true;await assert.rejects(f.jobs.status(actor,j.job_id,f.session),e=>e.status===403);assert.equal(reads,1);
});

test('concurrent prepare of the same fixed source uses one original remote job',async t=>{
 let prepares=0,release;const gate=new Promise(r=>release=r);
 const f=setup(t,async action=>{if(action==='prepare'){prepares++;await gate;return {job_id:remote};}return {state:'prepared'};});
 const first=f.jobs.prepare(actor,{input,external_audio_release:true},'prepare-one',f.session);
 const second=f.jobs.prepare(actor,{input,external_audio_release:true},'prepare-two',f.session);
 await new Promise(r=>setImmediate(r));assert.equal(prepares,1);release();
 const [one,two]=await Promise.all([first,second]);assert.equal(one.job_id,two.job_id);assert.equal(prepares,1);
});

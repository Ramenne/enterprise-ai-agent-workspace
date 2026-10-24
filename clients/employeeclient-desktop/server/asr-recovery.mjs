// Recover only an expired, provably unsent original run under the same caller.
// No new run, supplier fallback, reclaim or unknown-outcome resubmission.
const done=v=>['completed','published'].includes(v.state)||['completed','succeeded'].includes(v.technical_state);
const dispatched=v=>Boolean(v.intent_id||v.permit_id||v.provider_task_id||(v.dispatch_state&&v.dispatch_state!=='prepared')||['known','submitting','submission_unknown','delivery_unknown','running'].includes(v.state));
const fail=code=>{throw Object.assign(Error(code),{code,status:409,not_started:true});};
export async function startASRWithRecovery(args,{call,key,now=Date.now}){
 const run=args.job_id||args.run_id,job={project_id:args.project_id,job_id:run};
 if(!run||!args.project_id)fail('original_asr_job_required');
 let status=await call('status',job);
 if(done(status)||dispatched(status))return status;
 if(status.send_authorized===false||!['authorized','continuation_authorized'].includes(status.state)||status.state==='continuation_authorized'&&status.send_authorized!==true)fail('asr_send_not_authorized');
 const processing=await call('processing.query',{project_id:args.project_id,run_id:run});
 const expired=Number.isFinite(Date.parse(processing.lease_until))&&Date.parse(processing.lease_until)<=now();
 let startKey=Number.isSafeInteger(processing.attempt)&&processing.attempt>0?`qn-asr-start:${run}:${processing.attempt}`:key;
 if(expired){
  if(processing.run_id!==run||processing.semantic_kind!=='asr_transcription'||processing.technical_state!=='prepared'||!Number.isSafeInteger(processing.revision)||processing.revision<1||!Number.isSafeInteger(processing.attempt)||processing.attempt<1)fail('asr_recovery_state_changed');
  if(processing.reference_access?.hidden_inputs||processing.reference_access?.hidden_outputs||(processing.outputs||[]).length)fail('asr_recovery_source_unverified');
  const input=status.input_fixed_ref;
  if(!input||!Array.isArray(processing.inputs)||processing.inputs.length!==1||processing.inputs[0].source_stale===true||!['material_id','version_id','sha256'].every(k=>input[k]&&processing.inputs[0][k]===input[k]))fail('asr_recovery_source_unverified');
  const resumed=await call('processing.resume',{project_id:args.project_id,run_id:run,expected_revision:processing.revision,idempotency_key:`qn-asr-resume:${run}:${processing.revision}`});
  if(resumed.run_id!==run||resumed.attempt!==processing.attempt+1)fail('asr_recovery_state_changed');
  // Recheck current source/release authority after recovery, before any send.
  status=await call('status',job);
  if(done(status)||dispatched(status))return status;
  if(status.send_authorized!==true||status.attempt!==resumed.attempt)fail('asr_send_not_authorized');
  startKey=`qn-asr-start:${run}:${resumed.attempt}`;
 }
 return call('start',job,startKey);
}

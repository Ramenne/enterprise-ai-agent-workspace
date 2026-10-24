import {startASRWithRecovery} from './asr-recovery.mjs';
import {boundedJSON} from './business/bounded-json.mjs';
const CENTRAL='https://hufu.example.invalid/';
const ROUTE='/hub2-preview/hufu/v2/vault/project-use/';
const fail=(code,status=403)=>{throw Object.assign(Error(code),{code,status});};
// The caller's native session must bind the registered project use to the exact
// native ASR job. Engineering or manager credentials never replace the caller.
export async function routeProjectASR(name,args,{fetcher,headers,signal,target}){
 const action=name.slice('mem.asr.'.length);
 let dispatchAttempted=false,stage='validate';
 try {
 if(!['prepare','start','status','poll'].includes(action))fail('asr_action_invalid',400);
 if(action==='status'){
  if(args.job_id&&args.run_id&&args.job_id!==args.run_id)fail('asr_job_identity_mismatch',400);
  const job_id=args.job_id||args.run_id;if(!job_id)fail('original_asr_job_required',400);
  stage='result_read';
  // Reading an existing result requires current source rights, not a fresh model
  // licence; Mem performs that check using this same member session.
  return fetcher(CENTRAL+'/hub2-preview/mem/v2/asr/status',{method:'POST',headers,body:JSON.stringify({project_id:args.project_id,job_id}),redirect:'error',signal});
 }
 const selectedTarget=args.provider_target_id||target;
 if(typeof selectedTarget!=='string'||!selectedTarget)fail('asr_target_not_registered',503);
 stage='use_directory';const directory=await fetcher(CENTRAL+ROUTE+'directory',{method:'POST',headers,body:JSON.stringify({project_id:args.project_id}),redirect:'error',signal});
 const value=await directory.json();
 if(!directory.ok)fail(value.error_code||'asr_use_directory_rejected',directory.status);
 const matches=(value.items||[]).filter(x=>x.project_id===args.project_id&&x.mode==='asr'&&x.name===selectedTarget&&Date.parse(x.expires_at)>Date.now());
 if(matches.length!==1)fail('current_registered_asr_use_required');
 const parameters={...args,...(action==='prepare'?{provider_target_id:selectedTarget}:{})};
 if(action!=='prepare'){
  if(args.job_id&&args.run_id&&args.job_id!==args.run_id)fail('asr_job_identity_mismatch',400);
  parameters.job_id=args.job_id||args.run_id;delete parameters.run_id;
  if(typeof parameters.job_id!=='string')fail('original_asr_job_required',400);
 }
 const body={project_id:args.project_id,use_id:matches[0].use_id,action,parameters,...(args.idempotency_key?{idempotency_key:args.idempotency_key}:{})};
 if(action==='start'){
  const call=async(operation,parameters,key)=>{
   const direct=operation==='processing.query'?'/processing-runs/query':operation==='processing.resume'?'/processing-runs/resume':'/asr/status';
   const dispatch=operation==='start';
   const requestBody=dispatch?{...body,parameters,...(key?{idempotency_key:key}:{})}:parameters;
   if(dispatch)dispatchAttempted=true;
   stage=dispatch?'provider_dispatch':'original_recovery';
   const response=await fetcher(dispatch?CENTRAL+ROUTE+'execute':CENTRAL+'/hub2-preview/mem/v2'+direct,{method:'POST',headers,body:JSON.stringify(requestBody),redirect:'error',signal});
   const result=await boundedJSON(response,1024*1024);
   if(!response.ok||result.error_code)fail(result.error_code||'asr_recovery_rejected',response.status>=400?response.status:502);
   return result;
  };
  return Response.json(await startASRWithRecovery(parameters,{call,key:args.idempotency_key||headers['idempotency-key']}));
 }
 stage='use_'+action;const response=await fetcher(CENTRAL+ROUTE+'execute',{method:'POST',headers,body:JSON.stringify(body),redirect:'error',signal});
 if(!response.ok){const body=await boundedJSON(response,1024*1024);fail(body.error_code||'asr_use_rejected',response.status);}return response;
 }catch(error){
  // Pre-dispatch directory/status/recovery failures cannot have sent audio.
  // Once execute is attempted, retain ambiguity and never blindly resend.
  if(action==='start'&&!dispatchAttempted)error.not_started=true;
  error.asr_stage=stage;
  throw error;
 }
}

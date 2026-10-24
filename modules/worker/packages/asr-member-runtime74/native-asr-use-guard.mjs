/** Install inside the existing runtime's currentCheck AND immediately before
 * every /internal/asr/consume. Do not substitute a controller token. Binding is
 * set by server after reading real native Mem job status under same member.
 */
export function sharedASRGuard({checkBoundJob}){
 return async(ctx,job)=>{
  if(typeof ctx.api.checkSharedUse!=='function')throw Error('native_shared_use_authority_not_installed');
  return ctx.api.checkSharedUse({project_id:job.project_id,job_id:job.run_id??job.job_id,provider_target_id:job.provider_target_id});
 };
}
export function decorateASRAuthority(authority,checkBoundJob){
 return {...authority,callerFactory:async request=>{
  const api=await authority.callerFactory(request);
  return {...api,checkSharedUse:b=>checkBoundJob(request.token,b),consume:async permit=>{
   await checkBoundJob(request.token,{project_id:permit.project_id,job_id:permit.run_id??permit.job_id,provider_target_id:permit.provider_target_id});return api.consume(permit);
  }};
 }};
}
export function createVerifiedASRBinder({invokeNative,bindVerified}){
 return async(token,b)=>{
  const native=await invokeNative('mem',token,'/v2/asr/status',{project_id:b.project_id,job_id:b.job_id});const job=native.job??native;
  if(job.project_id!==b.project_id||(job.run_id??job.job_id??job.id)!==b.job_id||typeof job.actor_id!=='string')throw Error('native_ASR_job_identity_required');
  return bindVerified(token,{...b,native_actor_id:job.actor_id});
 };
}
export function originalCallerNativeInvoker(origins,fetcher=fetch){
 return async(system,token,path,body)=>{
  const allowed={hufu:['/v2/vault/apply','/v2/vault/reveal','/v2/engineering/management/challenge'],mem:['/v2/asr/prepare','/v2/asr/start','/v2/asr/status','/v2/asr/poll']};
  if(!allowed[system]?.includes(path))throw Error('native_public_route_not_registered');
  const base=new URL(origins[system]);if(base.username||base.password||base.search||base.hash||!(base.protocol==='https:'||base.protocol==='http:'&&base.hostname==='127.0.0.1'))throw Error('registered_native_origin_required');
  const response=await fetcher(new URL(path,base),{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
  const raw=await response.text();if(Buffer.byteLength(raw)>3*1024*1024)throw Error('native_response_limit');const result=JSON.parse(raw);
  if(!response.ok){const e=new Error(result.error_code??result.error??'native_permission_or_service_failed');e.statusCode=response.status;throw e}return result;
 };
}

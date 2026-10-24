import {createHash,randomUUID}from'node:crypto';
import {createVerifiedASRBinder}from'./native-asr-use-guard.mjs';
import{modelCredentialValues}from'./model-holder-format.mjs';
import{selectModelTarget,selectCredentialPool}from'./model-target-routing.mjs';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const need=(v,code)=>{if(!v){const e=new Error(code);e.code=code;e.statusCode=403;throw e}};
async function responseText(response){
 const limit=32*1024*1024;if(!response.body?.getReader){const text=await response.text();need(Buffer.byteLength(text)<=limit,'model_HTTP_response_budget_exceeded');return text}
 const reader=response.body.getReader(),parts=[];let bytes=0;try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;need(bytes<=limit,'model_HTTP_response_budget_exceeded');parts.push(Buffer.from(next.value))}return Buffer.concat(parts).toString('utf8')}finally{await reader.cancel().catch(()=>{})}
}
/** Original caller throughout. invokeNative calls registered public services;
 * readEntry is a server-only exact Bao entry resolver; never returns to caller.
 * Provider model target registry is installed by resource manager, no caller URL.
 */
export class VaultProjectUse{
 constructor({check,invokeNative,readEntry,modelTargets,receipts,bindASR,nativeASRGuardInstalled=false,fetcher=fetch}){Object.assign(this,{check,invokeNative,readEntry,modelTargets,receipts,bindASR,nativeASRGuardInstalled,fetcher})}
 async permit(token,r,phase){const p=await this.check(token,{use_id:r.use_id,project_id:r.project_id,phase});need(p.state==='authorized'&&p.project_id===r.project_id&&p.use_id===r.use_id&&Date.parse(p.deadline)>Date.now(),'current_vault_project_use_required');return p}
 async apply(token,r){const p=await this.permit(token,r,'apply');
  if(p.mode!=='delivery')return{state:'project_use_available_subject_to_native_permission',use_id:p.use_id,member_grant_created:false,native_permission_required:p.mode==='asr'?'current_ASR_external_release_and_fixed_source':'current_native_managed_action'};
  return this.invokeNative('hufu',token,'/v2/vault/apply',{entry_id:p.entry_id,purpose:{project_id:r.project_id,project_use_id:r.use_id,purpose:r.purpose},expires_at:r.expires_at,until_revoked:r.until_revoked??false,idempotency_key:r.idempotency_key});
 }
 async execute(token,r){
  need(r&&Object.keys(r).every(k=>['use_id','project_id','action','parameters','idempotency_key','conversation_id'].includes(k)),'project_use_request_invalid');
  const p=await this.permit(token,r,'start');const current=async phase=>{const next=await this.permit(token,r,phase);for(const k of['revision','actor_id','client_id','credential_id','entry_id','mode'])need(next[k]===p[k],'vault_use_revoked_or_changed');return next};
  if(p.mode==='delivery'){
   need(r.action==='reveal'&&Object.keys(r.parameters??{}).length===0,'native_vault_reveal_only');await current('effect');
   // Original Vault allowed_grant/filter remains mandatory and rechecks release.
   // No copied entries or secret values enter this module or its receipts.
   const result=await this.invokeNative('hufu',token,'/v2/vault/reveal',{entry_id:p.entry_id});await current('final');return result;
  }
  if(p.mode==='asr'){
   const paths={prepare:'/v2/asr/prepare',start:'/v2/asr/start',status:'/v2/asr/status',poll:'/v2/asr/poll'};
   need(paths[r.action]&&r.parameters&&r.parameters.project_id===r.project_id,'fixed_ASR_project_required');
   need(r.parameters.provider_target_id===undefined||r.parameters.provider_target_id==='bailian-beijing-asr','registered_ASR_target_required');
   if(['prepare','start','poll'].includes(r.action))need(this.nativeASRGuardInstalled===true,'native_ASR_use_guard_not_installed');
   await current('effect');
   if(['start','poll'].includes(r.action)){need(typeof r.parameters.job_id==='string','original_ASR_job_required');await this.bindASR(token,{use_id:r.use_id,project_id:r.project_id,job_id:r.parameters.job_id,expected_revision:p.revision})}
   const result=await this.invokeNative('mem',token,paths[r.action],r.parameters);
   if(r.action==='prepare'){const job=result.job??result;const job_id=job.run_id??job.job_id??job.id;need(typeof job_id==='string','original_ASR_prepare_job_required');await this.bindASR(token,{use_id:r.use_id,project_id:r.project_id,job_id,expected_revision:p.revision})}
   await current('final');return result;
  }
  if(p.mode==='email_otp'){
   // SES is the existing identity/manager verification service, not a general
   // arbitrary-recipient mail API. Existing backend resolves member email.
   need(r.action==='management_challenge'&&Object.keys(r.parameters??{}).length===0,'registered_identity_email_action_required');await current('effect');
   const result=await this.invokeNative('hufu',token,'/v2/engineering/management/challenge',{project_id:r.project_id});await current('final');return result;
  }
  need(p.mode==='model_proxy'&&['chat','models'].includes(r.action)&&typeof r.idempotency_key==='string'&&r.idempotency_key.length>0&&r.idempotency_key.length<=200,'registered_model_action_required');
  if(r.conversation_id!==undefined)need(typeof r.conversation_id==='string'&&r.conversation_id.length>0&&Buffer.byteLength(r.conversation_id)<=4096,'conversation_identifier_invalid');
  const targets=typeof this.modelTargets==='function'?await this.modelTargets():this.modelTargets;
  const target=selectModelTarget(targets,p.entry_id,p.project_id);need(target,'managed_model_target_not_registered');
  const body=r.parameters;const list=r.action==='models';
  if(list)need(body&&Object.keys(body).length===0&&typeof target.models_endpoint==='string','registered_model_list_required');
  else{
   need(body&&typeof body==='object'&&!Array.isArray(body),'managed_model_protocol_object_required');
   // Known models are discovery candidates. Only an explicit source grant's
   // enforced_models restricts authority; supplier capability decides support.
   if(Array.isArray(target.enforced_models))need(target.enforced_models.includes(body.model),'explicit_source_model_scope_denied');
   need(Buffer.byteLength(JSON.stringify(body))<=16*1024*1024,'model_HTTP_transport_budget_exceeded');
  }
  const endpoint=new URL(list?target.models_endpoint:target.endpoint);need(endpoint.protocol==='https:'&&!endpoint.username&&!endpoint.password&&!endpoint.search&&!endpoint.hash,'registered_model_HTTPS_endpoint_required');
  need(this.receipts?.begin&&this.receipts.get&&this.receipts.put,'durable_model_operation_journal_required');
  const key=hash([p.actor_id,p.client_id,r.use_id,r.idempotency_key]),requestHash=hash(r);const old=await this.receipts.get(key);
  const goSession=target.provider_session_header==='x-opencode-session';
  const canResume=goSession&&old?.state==='provider_rejected'&&old.provider_status===400&&old.result?.provider_error?.type==='MissingSessionID';
  if(old){need(old.request_hash===requestHash,'model_idempotency_conflict');await current('effect');if(!canResume)return{...old,replayed:true}}
  // Agent normally supplies its native thread/conversation record. When absent,
  // create a reusable conversation ID for this conversation, not the whole use.
  const conversationId=r.conversation_id??old?.conversation_id??('managed-conversation:'+randomUUID());
  const sessionId=hash([p.actor_id,p.client_id,p.project_id,r.use_id,conversationId]);
  const pending={operation_id:key,request_hash:requestHash,use_id:r.use_id,use_revision:p.revision,actor_id:p.actor_id,client_id:p.client_id,conversation_id:conversationId,conversation_source:r.conversation_id?'Agent_native_thread_or_record':'generated_reusable_id;reuse_for_followups',state:'provider_outcome_pending_reconcile_required',automatic_effect_retry:false,...(canResume?{resumed_known_no_effect:true,previous_no_effect:{provider_status:old.provider_status,provider_error:old.result.provider_error,operation_id:old.operation_id}}:{})};
  if(canResume){need(this.receipts.resumeMissingSession,'known_no_effect_recovery_not_installed');if(!await this.receipts.resumeMissingSession(key,pending))return{...await this.receipts.get(key),replayed:true}}
  else if(!await this.receipts.begin(key,pending))return{...await this.receipts.get(key),replayed:true};
  // Resolve the actual parent entry only inside the protected service. It must
  // verify current entry identity/revision/active state and exact KV custody.
  await current('effect');const secret=await this.readEntry(p.entry_id,{token,caller:p,project_use_id:r.use_id,project_id:r.project_id});
  need(secret?.entry_id===p.entry_id&&secret.active===true&&typeof secret.value==='string','current_managed_entry_required');
  const credentialPool=selectCredentialPool(modelCredentialValues(secret.value),target);need(credentialPool.length>0,'registered_holder_credential_format_needed');
  let response,raw,holderAttempts=0;try{
   for(const value of credentialPool){await current('effect');holderAttempts++;response=await this.fetcher(endpoint,{method:list?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(target.timeout_ms??180000),headers:{authorization:'Bearer '+value,'content-type':'application/json','user-agent':'workspace-managed-project-agent/2.0',...(goSession?{'x-opencode-session':sessionId}:{})},...(!list?{body:JSON.stringify(body)}:{})});raw=await responseText(response);for(const own of credentialPool)raw=raw.split(own).join('[credential_redacted]');
    // A definitive auth rejection from one labelled key can continue with
    // another already-owned key in the same original pool. Unknown effects,
    // rate limits or paid work are never blindly sent again.
    if(response.status!==401)break;
   }
  }finally{secret.value=undefined;credentialPool.fill('')}
  await current('final');
  let parsed;try{parsed=JSON.parse(raw)}catch{parsed=null}
  // MCP returns JSON; preserve complete provider SSE events when Agent asks
  // for streaming, rather than silently changing the requested protocol.
  const stream=body?.stream===true&&response.headers?.get('content-type')?.includes('text/event-stream');
  if(stream)parsed={stream_requested:true,transport:'complete_provider_SSE_events',events:raw.split(/\r?\n/).filter(x=>x.startsWith('data:')).map(x=>{const text=x.slice(5).trim();if(text==='[DONE]')return{done:true};try{return JSON.parse(text)}catch{return{event_parse_state:'unparsed_provider_event',text}}})};
  const supplierErrorCode=Number.isInteger(parsed?.base_resp?.status_code)?parsed.base_resp.status_code:null;
  const successful=response.ok&&parsed&&!parsed.error&&(!supplierErrorCode||supplierErrorCode===0)&&(list?Array.isArray(parsed.data):stream||Array.isArray(parsed.choices));
  const supplierState=successful?(list?'supplier_model_list_read':'supplier_call_executed'):({401:'supplier_authentication_failed',402:'supplier_credit_or_plan_required',403:'supplier_scope_denied',429:'supplier_limit',400:'supplier_input_or_model_not_supported'}[response.status]??(supplierErrorCode===1008?'supplier_credit_or_plan_required':'supplier_response_not_successful'));
  // Provider error messages can echo credentials. Return a precise status class,
  // not arbitrary error text or response headers from the credential custodian.
  const providerError=!successful&&parsed?.error;const supplierDiagnostics=providerError&&typeof providerError==='object'?Object.fromEntries(['message','type','code','param'].filter(k=>typeof providerError[k]==='string'||typeof providerError[k]==='number').map(k=>[k,providerError[k]])):typeof providerError==='string'?{message:providerError}:null;
  // The response has already had every actual holder key redacted above.
  // Preserve only useful provider error fields for this same authorized caller;
  // do not return arbitrary response headers or the full error object.
  const result={...pending,state:successful?'executed':'provider_rejected',supplier_state:supplierState,provider_status:response.status,supplier_error_code:supplierErrorCode,holder_attempts:holderAttempts,result:successful?parsed:{state:supplierState,http_status:response.status,supplier_error_code:supplierErrorCode,...(supplierDiagnostics?{provider_error:supplierDiagnostics}:{})}};await this.receipts.put(key,result);return result;
 }
}

export function installVaultProjectUse(app,pool,options){
 const proof=token=>createHash('sha256').update(token).digest('hex');
 const sql=async(token,fn,b)=>{const result=await pool.query('select vault2.'+fn+'($1::text,$2::jsonb) as result',[proof(token),b]);return result.rows[0].result};
 const token=req=>{const h=req.headers.authorization;need(typeof h==='string'&&h.startsWith('Bearer ')&&h.slice(7),'member_authentication_required');return h.slice(7)};
 const bindASR=options.bindASR??createVerifiedASRBinder({invokeNative:options.invokeNative,bindVerified:(t,b)=>sql(t,'project_use_bind_verified',b)});
 const gateway=new VaultProjectUse({...options,bindASR,check:(t,b)=>sql(t,'project_use_check',b)});
 for(const[route,fn]of Object.entries({save:'project_use_save',change:'project_use_change',directory:'project_use_directory',check:'project_use_check'}))app.post('/v2/vault/project-use/'+route,{logLevel:'silent'},async req=>sql(token(req),fn,req.body));
 app.post('/v2/vault/project-use/apply',{logLevel:'silent'},async req=>gateway.apply(token(req),req.body));
 app.post('/v2/vault/project-use/job-check',{logLevel:'silent'},async req=>sql(token(req),'project_use_check_job',req.body));
 app.post('/v2/vault/project-use/execute',{logLevel:'silent',bodyLimit:16*1024*1024},async(req,reply)=>{reply.header('cache-control','no-store');return gateway.execute(token(req),req.body)});
 return gateway;
}

/** Uses the actual existing secret SDK readKV and exact Vault value_field.
 * The locator SQL function must not be exposed as a public route. */
export function createManagedEntryReader({pool,secretClient}){
 return async(entry_id,{token,project_use_id,project_id})=>{
  const proof=createHash('sha256').update(token).digest('hex');
  const result=await pool.query('select vault2.project_use_secret($1::text,$2::jsonb) as result',[proof,{use_id:project_use_id,project_id,entry_id}]);
  const locator=result.rows[0].result;need(locator.entry_id===entry_id&&locator.state==='current_managed_entry','managed_entry_locator_mismatch');
  const record=(await secretClient.readKV(locator.secret_ref)).data;
  const value=record[locator.value_field];need(typeof value==='string'&&value.length>0,'registered_model_key_field_required');
  return{entry_id,active:true,value};
 };
}

import {providerFailure} from './cos-tier-provider.mjs';
// Integrates with createServer's current call(): fresh Hufu handle + SQL digest
// for every transition. No caller-supplied locator, endpoint, credential or outcome.
export function registerStorageTiers(app,{z,bearer,sourceFromRequest,call,digest,DomainError,provider,budget,afterCopyCreated}) {
 const scope={project_id:z.uuid(),material_id:z.uuid(),version_id:z.uuid()};
 const command=z.enum(['archive_copy','restore']);
 const key=z.string().min(1).max(200);
 const schemas={
  archive:z.object({...scope,idempotency_key:key,tier:z.enum(['infrequent','archive','deep_archive'])}).strict(),
  restore:z.object({...scope,idempotency_key:key,copy_id:z.uuid().optional(),days:z.number().int().min(1).max(365),retrieval:z.enum(['Standard','Bulk','Expedited'])}).strict(),
  status:z.object({...scope,operation_id:z.uuid(),command}).strict()
 };
 const publicResult=r=>({operation_id:r.operation_id,state:r.state,command:r.command,receipt:r.receipt??null,
  logical_identity_unchanged:true,receipt_scope:'operation_event_snapshot',automatic_effect_retry:false});
 const action=cmd=>cmd==='archive_copy'?'mem.write':'mem.read';
 for(const route of ['archive','restore','status'])app.post('/v2/objects/storage-tier/'+route,async(request,reply)=>{
  const parsed=schemas[route].safeParse(request.body);if(!parsed.success)throw new DomainError('invalid_input');
  const b=parsed.data,token=bearer(request),source=sourceFromRequest(request);
  const cmd=route==='archive'?'archive_copy':route==='restore'?'restore':b.command;
  const query=(phase,extra={})=>call(token,source,'storage_tier_command',phase==='status'?'mem.read':action(cmd),{...b,command:cmd,phase,...extra});
  let ticket=await query(route==='status'?'status':'prepare');
  const ref={project_id:b.project_id,material_id:b.material_id,version_id:b.version_id};
  // Operation receipts describe the accepted event. Return current placement
  // separately so an Agent can decide whether a hot source still exists.
  const currentResult=async r=>{
   const result=publicResult(r);
   try{const info=await call(token,source,'storage_tier_info','mem.read',ref);
    return {...result,standard_source_retained:info.hot_deleted===false,hot_deleted:info.hot_deleted,primary_tier:info.primary_tier,storage_state:info};}
   catch{return {...result,standard_source_retained:null,storage_state:'unavailable',next_step:'query_mem.object.storage_info'};}
  };
  if(!provider)return reply.code(503).send({...await currentResult(ticket),state:ticket.state,capability:'unavailable',provider_send_count:0});
  // All external operations are covered by a current read-use lease, and all
  // effects have an immediate fresh permission check in SQL dispatch.
  const read=await call(token,source,'read_version','mem.read',ref);
  const lease={...ref,read_receipt_id:read.read_receipt_id,sha256:ticket.sha256,ttl_seconds:900};
  let lastRenew=0;
  const renew=async()=>{if(Date.now()-lastRenew>=5000){await call(token,source,'gc_read_lease','mem.read',{...lease,command:'renew'});lastRenew=Date.now();}};
  const report=async(outcome,receipt)=>{
   ticket=await query('report',{operation_id:ticket.operation_id,original_request_hash:ticket.original_request_hash,outcome,receipt});
   return currentResult(ticket);
  };
  const verify=async(locator)=>{
   const capacity=await budget?.acquire('verify',Number(ticket.size));
   try {await renew();return await provider.verify(locator,{sha256:ticket.sha256,size:Number(ticket.size)},renew);}
   finally{await capacity?.release();}
  };
  let dispatched=false;
  const dispatch=async({target_key})=>{
   await renew();ticket=await query('dispatch',{operation_id:ticket.operation_id,original_request_hash:ticket.original_request_hash,
    read_receipt_id:read.read_receipt_id,target_key});dispatched=true;
  };
  try {
   if(route==='status') {
    // Read-only provider reconciliation: never calls COPY or RESTORE again.
    if(cmd==='archive_copy'&&['dispatched','unknown'].includes(ticket.state)){
     try {return await report('copy_created',await provider.reconcileCopy(ticket));}
     catch(e){return {...await currentResult(ticket),observation:providerFailure(e),next_step:'retain_unknown_no_second_copy'};}
    }
    if(cmd==='restore'){
     const observed=await provider.head(ticket.locator);
     if(['readable','restored'].includes(observed.state))return {...await report('verified',{...await verify(ticket.locator),restore_expires_at:observed.restore_expires_at}),observation:observed};
     return {...await currentResult(ticket),observation:observed,next_step:observed.state==='restore_required'?'request_new_restore_after_current_scope_check':'query_same_operation'};
    }
    return currentResult(ticket);
   }
   if(ticket.state!=='prepared')return {...await currentResult(ticket),next_step:'query_same_operation_no_automatic_resend'};
   if(cmd==='archive_copy'){
    // The source is already a verified immutable version; COPY pins that version.
    const receipt=await provider.copy(ticket,dispatch);
    await report('copy_created',receipt);
    await call(token,source,'gc_read_lease','mem.read',{...lease,command:'release'});
    let placement;try{placement=await afterCopyCreated?.(token,source,{project_id:b.project_id,material_id:b.material_id,version_id:b.version_id,operation_id:ticket.operation_id});}catch{placement={state:'pending',next_step:'resume_same_archive_switch'};}
    return reply.code(202).send({...await currentResult(ticket),placement});
   }
   const receipt=await provider.restore(ticket,dispatch);
   if(receipt.state==='readable')return await report('verified',{...await verify(ticket.locator),restore_expires_at:receipt.restore_expires_at});
   return reply.code(202).send(await report(receipt.state,receipt));
  }catch(e){
   if(dispatched){
    // A provider response is already durable in the own journal before SQL report.
    // If reauthorization or SQL fails, the unknown intent is retained for recovery.
    await report(e.code==='no_provider_send'?'no_effect':'unknown',null).catch(()=>{});
    return reply.code(202).send({...await currentResult(ticket),state:e.code==='no_provider_send'?'prepared':'unknown',
     observation:providerFailure(e),next_step:'query_same_operation_before_any_effect_retry'});
   }
   throw new DomainError(providerFailure(e),e.status??503,false);
  }finally{await call(token,source,'gc_read_lease','mem.read',{...lease,command:'release'}).catch(()=>{});}
 });
}

/** Preserve adapter capabilities/prototypes. The provider error must be classified
 * before generic 403. Existing authorization/cache/fullSHA read pipeline remains. */
export function withRestoreRequired(adapter,DomainError) {
 return new Proxy(adapter,{get(target,property){
  if(property==='read')return async(...args)=>{try{return await target.read(...args);}catch(e){
   if(providerFailure(e)==='restore_required')throw new DomainError('restore_required',409,false);throw e;}};
  const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
 }});
}

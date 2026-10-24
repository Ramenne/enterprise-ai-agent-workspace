/** Restore waiting is explicit. A successful standard COPY is registered before changing the read locator. */
export function createMaterialWarming({z,call,provider,DomainError,storage}){
 return async(authority,input)=>{
  const r=z.object({project_id:z.uuid(),material_id:z.uuid(),version_id:z.uuid(),idempotency_key:z.string().min(1).max(160)}).strict().safeParse(input);if(!r.success)throw new DomainError('invalid_input');
  const b=r.data,{token,source}=authority,scope={project_id:b.project_id,material_id:b.material_id,version_id:b.version_id};
  const current=await call(token,source,'storage_tier_info','mem.read',scope);
  if(current.primary_tier==='standard')return{state:'standard',primary_tier:'standard',logical_identity_unchanged:true};
  if(!provider)throw new DomainError('storage_provider_unavailable',503);
  const control=(phase,extra={})=>call(token,source,'storage_warm_control','mem.write',{...b,phase,...extra});
  let ticket=await control('prepare');
  if(ticket.state==='verified')return{state:'new_intent_required',operation_id:ticket.operation_id,desired_tier:'standard',primary_tier:current.primary_tier,receipt:ticket.receipt,receipt_scope:'operation_event_snapshot',recovery:{mode:'new_intent',reason:'completed_operation_does_not_describe_current_placement'},next_step:'submit_new_warm_intent_with_new_key',logical_identity_unchanged:true};
  const observed=await provider.head(ticket.locator);
  if(observed.state==='restore_required'||observed.state==='restoring'){
   let restoration=null;
   if(observed.state==='restore_required'){
    const response=await storage('restore',authority,{...scope,idempotency_key:b.idempotency_key+':restore',days:7,retrieval:'Standard'});restoration=response.body;
    if(response.status>=400)return{state:'restore_pending',operation_id:ticket.operation_id,recovery:{command:'warm',arguments:b,mode:'resume_original_intent'},desired_tier:'standard',primary_tier:current.primary_tier,restoration,next_step:'resume_same_warm_key_after_dependency_recovery'};
   }
   return{state:'restoring',operation_id:ticket.operation_id,recovery:{command:'warm',arguments:b,mode:'resume_original_intent'},desired_tier:'standard',primary_tier:current.primary_tier,restoration,next_step:'resume_same_warm_key_when_restore_is_ready',logical_identity_unchanged:true};
  }
  const read=await call(token,source,'read_version','mem.read',scope);const lease={...scope,sha256:ticket.sha256,read_receipt_id:read.read_receipt_id,ttl_seconds:900};
  await call(token,source,'gc_read_lease','mem.read',{...lease,command:'renew'});
  try{
   let receipt;
   if(ticket.state==='unknown'||ticket.state==='dispatched')receipt=await provider.reconcileCopy(ticket);
   else {
    try{receipt=await provider.copy(ticket,async({target_key})=>{ticket=await control('dispatch',{operation_id:ticket.operation_id,target_key,read_receipt_id:read.read_receipt_id});});}
    catch(e){if(ticket.state==='dispatched')await control('unknown',{operation_id:ticket.operation_id});throw e;}
   }
   const done=await control('report',{operation_id:ticket.operation_id,receipt});return{state:'warmed',primary_tier:'standard',operation_id:done.operation_id,receipt:done.receipt,logical_identity_unchanged:true};
  }finally{await call(token,source,'gc_read_lease','mem.read',{...lease,command:'release'}).catch(()=>undefined);}
 };
}
export function registerMaterialWarming(app,deps){
 const execute=createMaterialWarming(deps);
 app.post('/v2/objects/storage-tier/warm',request=>execute({token:deps.bearer(request),source:deps.sourceFromRequest(request),request_id:request.id},request.body));
 return execute;
}

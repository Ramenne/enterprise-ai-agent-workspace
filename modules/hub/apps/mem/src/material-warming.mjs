/** Restore waiting is explicit. A successful standard COPY is registered before changing the read locator. */
export function registerMaterialWarming(app,{z,bearer,sourceFromRequest,call,provider,DomainError}){
 app.post('/v2/objects/storage-tier/warm',async request=>{
  const r=z.object({project_id:z.uuid(),material_id:z.uuid(),version_id:z.uuid(),idempotency_key:z.string().min(1).max(160)}).strict().safeParse(request.body);if(!r.success)throw new DomainError('invalid_input');
  const b=r.data,token=bearer(request),source=sourceFromRequest(request),scope={project_id:b.project_id,material_id:b.material_id,version_id:b.version_id};
  const current=await call(token,source,'storage_tier_info','mem.read',scope);
  if(current.primary_tier==='standard')return{state:'standard',primary_tier:'standard',logical_identity_unchanged:true};
  if(!provider)throw new DomainError('storage_provider_unavailable',503);
  const control=(phase,extra={})=>call(token,source,'storage_warm_control','mem.write',{...b,phase,...extra});
  let ticket=await control('prepare');
  if(ticket.state==='verified')return{state:'warmed',primary_tier:'standard',receipt:ticket.receipt,logical_identity_unchanged:true};
  const observed=await provider.head(ticket.locator);
  if(observed.state==='restore_required'||observed.state==='restoring'){
   let restoration=null;
   if(observed.state==='restore_required'){
    const response=await app.inject({method:'POST',url:'/v2/objects/storage-tier/restore',headers:{authorization:'Bearer '+token},payload:{...scope,idempotency_key:b.idempotency_key+':restore',days:7,retrieval:'Standard'}});restoration=response.json();
    if(response.statusCode>=400)return{state:'restore_pending',desired_tier:'standard',primary_tier:current.primary_tier,restoration,next_step:'resume_same_warm_key_after_dependency_recovery'};
   }
   return{state:'restoring',desired_tier:'standard',primary_tier:current.primary_tier,restoration,next_step:'resume_same_warm_key_when_restore_is_ready',logical_identity_unchanged:true};
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
 });
}

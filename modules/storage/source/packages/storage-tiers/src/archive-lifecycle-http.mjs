/** Optional Mem integration. All physical locator details stay internal. */
export function createArchiveLifecycleOperations({z,DomainError,lifecycle,call}){
 const specs=archiveLifecycleTools(z);
 return async(route,{token,source},input)=>{
  const spec=specs.find(x=>x.path.endsWith('/'+route));
  if(!spec)throw new DomainError('invalid_input');
  const parsed=spec.schema.safeParse(input);if(!parsed.success)throw new DomainError('invalid_input');
  if(route==='info')return call(token,source,'storage_tier_info','mem.read',parsed.data);
  try{
   const r=await lifecycle(token,source,parsed.data,{switchOnly:route==='switch',queryOnly:route==='retirement-status'});
   return {operation_id:r.operation_id,retirement_id:r.retirement_id,state:r.state,reason:r.reason,
    primary_tier:r.primary_tier,hot_deleted:r.hot_deleted===true,logical_identity_unchanged:true,
    receipt:r.receipt??null,automatic_delete_retry:false};
  }catch(e){
   if(e.code==='P0001'&&e.message==='known_archive_copy_required')throw new DomainError('known_archive_copy_required',409,false);
   if(e instanceof DomainError||['42501','23505','40001','55P03','57014','H2410','H2409'].includes(e.code))throw e;throw new DomainError(e.code??'storage_tier_dependency_unavailable',e.status??503,false);}
 };
}
export function registerArchiveLifecycle(app,deps){
 const execute=createArchiveLifecycleOperations(deps);
 for(const spec of archiveLifecycleTools(deps.z))app.post(spec.path,request=>execute(spec.path.split('/').at(-1),{token:deps.bearer(request),source:deps.sourceFromRequest(request),request_id:request.id},request.body));
 return execute;
}

export function archiveLifecycleTools(z){
 const schema=z.object({project_id:z.uuid(),material_id:z.uuid(),version_id:z.uuid(),operation_id:z.uuid()}).strict();
 return [
  {name:'mem.object.storage_info',path:'/v2/objects/storage-tier/info',action:'mem.read',schema:z.object({project_id:z.uuid(),material_id:z.uuid(),version_id:z.uuid()}).strict()},
  {name:'mem.object.archive_switch',path:'/v2/objects/storage-tier/switch',action:'mem.write',schema},
  {name:'mem.object.archive_retirement_status',path:'/v2/objects/storage-tier/retirement-status',action:'mem.read',schema},
  {name:'mem.object.archive_retirement_resume',path:'/v2/objects/storage-tier/resume-retirement',action:'mem.write',schema}
 ];
}

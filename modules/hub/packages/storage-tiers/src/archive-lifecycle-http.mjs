/** Optional Mem integration. All physical locator details stay internal. */
export function registerArchiveLifecycle(app,{z,bearer,sourceFromRequest,DomainError,lifecycle,call}) {
 const body=z.object({project_id:z.uuid(),material_id:z.uuid(),version_id:z.uuid(),operation_id:z.uuid()}).strict();
 app.post('/v2/objects/storage-tier/info',async request=>{const b=z.object({project_id:z.uuid(),material_id:z.uuid(),version_id:z.uuid()}).strict().safeParse(request.body);if(!b.success)throw new DomainError('invalid_input');return call(bearer(request),sourceFromRequest(request),'storage_tier_info','mem.read',b.data);});
 for(const route of ['switch','retirement-status','resume-retirement'])app.post('/v2/objects/storage-tier/'+route,async(request,reply)=>{
  const parsed=body.safeParse(request.body);if(!parsed.success)throw new DomainError('invalid_input');
  try {
   const r=await lifecycle(bearer(request),sourceFromRequest(request),parsed.data,{switchOnly:route==='switch',queryOnly:route==='retirement-status'});
   // These are operational consequences of the accepted archive request, not
   // another human confirmation step. No irreversible_confirmed parameter.
   return {operation_id:r.operation_id,retirement_id:r.retirement_id,state:r.state,reason:r.reason,
    primary_tier:r.primary_tier,hot_deleted:r.hot_deleted===true,logical_identity_unchanged:true,
    receipt:r.receipt??null,automatic_delete_retry:false};
  }catch(e){throw new DomainError(e.code??'storage_tier_dependency_unavailable',e.status??503,false);}
 });
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

import {infrastructureFailure} from '../../../packages/platform/src/failure-contract.mjs';
/** Same-caller current location. The SQL locator is not an authorization result. */
export function registerMaterialLocate(app,{z,bearer,sourceFromRequest,DomainError,pool,sqlFunction,call,hufuUrl,fetcher=fetch}){
 const schema=z.object({material_id:z.uuid(),version_id:z.uuid().optional()}).strict();const endpoint=new URL('/v2/me',hufuUrl);
 if(!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)||!['http:','https:'].includes(endpoint.protocol)||endpoint.username||endpoint.password)throw Error('protected_current_Hufu_required');
 app.post('/v2/materials/locate',async request=>{
  const parsed=schema.safeParse(request.body);if(!parsed.success)throw new DomainError('invalid_input');
  const token=bearer(request),source=sourceFromRequest(request),material_id=parsed.data.material_id;let response;
  try{response=await fetcher(endpoint,{headers:{authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(5000)})}catch{throw new DomainError('authentication_dependency_unavailable',503,true)}
  if(!response.ok){await response.body?.cancel();if(response.status>=500)throw new DomainError('authentication_dependency_unavailable',503,true);throw new DomainError(response.status===401?'unauthenticated':'forbidden',response.status===401?401:403)}
  const identity=await response.json();if(!identity?.actor_id)throw new DomainError('unauthenticated',401);
  const project_id=await sqlFunction(pool,'mem.material_published_project_internal',[material_id,parsed.data.version_id??null]);if(!project_id)throw new DomainError('forbidden',403);
  if(parsed.data.version_id){
   const scoped={project_id,material_id,version_id:parsed.data.version_id};let prepared;
   try{
    try{prepared=await call(token,source,'read_version','mem.read',scoped)}catch(e){if(infrastructureFailure(e))throw e;if(e.status===403||e.code==='forbidden')throw new DomainError('forbidden',403);throw e}
    const fixed=prepared.fixed_ref;if(!fixed||fixed.material_id!==material_id||fixed.version_id!==scoped.version_id)throw new DomainError('forbidden',403);
    return{state:'authorized_fixed_reference',project_id,material_id,fixed_ref:{project_id,material_id,version_id:fixed.version_id,sha256:fixed.sha256,size:fixed.size},selection:'fixed_version_at_current_location',coverage:'current_caller_authorized_fixed_material_location'};
   }finally{if(prepared?.read_receipt_id)await call(token,source,'gc_read_lease','mem.read',{...scoped,read_receipt_id:prepared.read_receipt_id,command:'release'})}
  }
  let head;
  try{head=await call(token,source,'material_head','mem.read',{project_id,material_id})}
  catch(e){if(infrastructureFailure(e))throw e;if(e.status===403||e.code==='forbidden')throw new DomainError('forbidden',403);throw e}
  // material_head retains the existing current permission/family/SourceClosure
  // and final assert_effect. A concurrent cross-project move causes refusal;
  // the internal location is never returned by itself.
  const fixed=head.fixed_ref;if(!fixed||fixed.material_id!==material_id)throw new DomainError('forbidden',403);
  return{state:head.state,project_id,material_id,fixed_ref:{project_id,material_id,version_id:fixed.version_id,sha256:fixed.sha256,size:fixed.size},content_revision:head.content_revision,metadata_revision:head.metadata_revision,scope_revision:head.scope_revision,event_revision:head.event_revision,placements:head.placements??[],selection:'current_location_and_latest_at_request',source_stale:head.source_stale??false,observed_at:head.observed_at,coverage:'current_caller_authorized_material_location'};
 });
}
export function materialLocateTool(z){return{name:'mem.material.locate',service:'mem',method:'POST',path:'/v2/materials/locate',readOnly:true,description:'Locate a stable material ID at its current authorized project/head after moves. Current SourceClosure applies; unknown/invisible material locations are not disclosed.',schema:z.object({material_id:z.uuid(),version_id:z.uuid().optional()}).strict()}}

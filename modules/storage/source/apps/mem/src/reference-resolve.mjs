import {infrastructureFailure} from '../../../packages/platform/src/failure-contract.mjs';
/** Register on current Mem. call is the existing SAME-caller Hufu decide ->
 * read_version / SourceClosure / assert_effect SQL path. Never a controller token. */
export function registerReferenceResolve(app,{z,bearer,sourceFromRequest,DomainError,pool,sqlFunction,call,hufuUrl,fetcher=fetch}){
 const schema=z.object({material_id:z.uuid(),version_id:z.uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict();
 const endpoint=new URL('/v2/me',hufuUrl);
 if(!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)||!['http:','https:'].includes(endpoint.protocol)||endpoint.username||endpoint.password)
  throw Error('protected_current_Hufu_required');
 app.post('/v2/references/resolve',async request=>{
  const parsed=schema.safeParse(request.body);if(!parsed.success)throw new DomainError('invalid_input');
  const b=parsed.data,token=bearer(request),source=sourceFromRequest(request);
  // Validate current principal/client/family before touching internal locator.
  let response;
  try{response=await fetcher(endpoint,{headers:{authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(5000)});}
  catch{throw new DomainError('authentication_dependency_unavailable',503,true);}
  if(!response.ok){await response.body?.cancel();if(response.status>=500)throw new DomainError('authentication_dependency_unavailable',503,true);
   throw new DomainError(response.status===401?'unauthenticated':'forbidden',response.status===401?401:403);}
  const identity=await response.json();if(!identity?.actor_id)throw new DomainError('unauthenticated',401);
  const project=await sqlFunction(pool,'mem.fixed_reference_project_internal',[b.material_id,b.version_id]);
  // Unknown and unauthorized references return the same privacy-safe refusal.
  if(!project)throw new DomainError('forbidden',403);
  const scoped={project_id:project,material_id:b.material_id,version_id:b.version_id};
  let prepared;
  try{
   try{prepared=await call(token,source,'read_version','mem.read',scoped);}
   catch(e){if(infrastructureFailure(e))throw e;if(e.status===403||e.code==='forbidden')throw new DomainError('forbidden',403);throw e;}
   const ref=prepared.fixed_ref;
   if(!ref||ref.material_id!==b.material_id||ref.version_id!==b.version_id)throw new DomainError('reference_dependency_invalid',503);
   if(b.sha256&&b.sha256!==ref.sha256)throw new DomainError('fixed_reference_mismatch',409);
   // No raw project lookup, object key, actor text or read token is exposed.
   return{state:'authorized_fixed_reference',fixed_ref:{project_id:project,material_id:ref.material_id,version_id:ref.version_id,sha256:ref.sha256,size:ref.size}};
  }finally{
   if(prepared?.read_receipt_id)await call(token,source,'gc_read_lease','mem.read',{...scoped,read_receipt_id:prepared.read_receipt_id,command:'release'});
  }
 });
}
export function fixedReferenceResolveTool(z){return{name:'mem.reference.resolve',service:'mem',method:'POST',path:'/v2/references/resolve',readOnly:true,
 description:'Resolve a fixed material/version to its true source project under your current permission and SourceClosure; private unauthorized locators are not returned.',
 schema:z.object({material_id:z.uuid(),version_id:z.uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict()};}

const routes={
 list:{path:'/v2/materials/search',keys:['project_id','query','properties','limit'],required:['project_id'],logical:true},
 info:{path:'/v2/objects/storage-tier/info',keys:['project_id','material_id','version_id'],required:['project_id','material_id','version_id']},
 restore:{path:'/v2/objects/storage-tier/restore',keys:['project_id','material_id','version_id','idempotency_key','copy_id','days','retrieval'],required:['project_id','material_id','version_id','idempotency_key','days','retrieval']},
 status:{path:'/v2/objects/storage-tier/status',keys:['project_id','material_id','version_id','operation_id','command'],required:['project_id','material_id','version_id','operation_id','command']}
};
const fail=(code,status=400)=>{const e=new Error(code);e.statusCode=status;throw e};
/** Production COS is reached through Mem's actual fixed locators and current
 * member/project checks. The resource catalog does not expose physical keys or
 * perform an IAM-bypassing ListBucket. No new software resource.* ceiling needed. */
export class MemStorageNavigation{
 constructor(invokeMem){this.invokeMem=invokeMem}
 async execute(bearer,action,body){
  const route=routes[action];if(!route||!body||typeof body!=='object'||Array.isArray(body))fail('storage_navigation_invalid');
  if(Object.keys(body).some(k=>!route.keys.includes(k))||route.required.some(k=>body[k]===undefined||body[k]===null))fail('fixed_mem_scope_required');
  if(typeof bearer!=='string'||!bearer)fail('member_authentication_required',401);
  const result=await this.invokeMem(bearer,route.path,body);
  // HTTP status/body and original operation number remain authoritative.
  return {...result,navigation:{backend:'mem_current_project_scope',action,physical_bucket_access_granted:false,member_qualification_changed:false,...(route.logical?{list_coverage:'authorized_logical_search; ranked bounded result, not full bucket enumeration'}:{}),...(action==='restore'||action==='status'?{readable_only_when_provider_status_verified:true,automatic_effect_retry:false}:{})}};
 }
}
export function installMemStorageNavigation(app,{memOrigin}){
 const base=new URL(memOrigin);if(base.username||base.password||base.search||base.hash||!['http:','https:'].includes(base.protocol))throw Error('registered_mem_origin_required');
 const nav=new MemStorageNavigation(async(token,path,body)=>{
  const response=await fetch(new URL(path,base),{method:'POST',redirect:'error',signal:AbortSignal.timeout(25000),headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
  const raw=await response.text();if(Buffer.byteLength(raw)>3*1024*1024)fail('mem_response_limit',502);return {status:response.status,body:JSON.parse(raw)};
 });
 for(const action of Object.keys(routes))app.post('/v2/resources/storage/'+action,async(req,reply)=>{
  const auth=req.headers.authorization;if(typeof auth!=='string'||!auth.startsWith('Bearer '))fail('member_authentication_required',401);
  const result=await nav.execute(auth.slice(7),action,req.body);return reply.code(result.status).send({body:result.body,navigation:result.navigation});
 });
}
export const memStorageRoutes=routes;

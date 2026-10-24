/** The internal number map never authorizes: final same-caller guard runs against the resolved material. */
export function registerFileNumber(app,{z,bearer,sourceFromRequest,DomainError,pool,sqlFunction,call,hufuUrl,fetcher=fetch}){
 const numberSchema=z.string().trim().regex(/^(?:F-[0-9]+(?:-[0-9]+)?|#?[0-9]+|[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})$/);
 const schema=z.union([z.object({number:numberSchema}).strict(),z.object({file_no:numberSchema}).strict().transform(b=>({number:b.file_no}))]);
 const endpoint=new URL('/v2/me',hufuUrl);if(!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname))throw Error('protected_current_Hufu_required');
 app.post('/v2/materials/by-number',async request=>{
 const parsed=schema.safeParse(request.body);if(!parsed.success)throw new DomainError('invalid_input');
 const token=bearer(request),source=sourceFromRequest(request);let response;
 try{response=await fetcher(endpoint,{headers:{authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(5000)})}catch{throw new DomainError('authentication_dependency_unavailable',503,true)}
 if(!response.ok){await response.body?.cancel();throw new DomainError(response.status===401?'unauthenticated':response.status>=500?'authentication_dependency_unavailable':'forbidden',response.status>=500?503:response.status)}
 const identity=await response.json();if(!identity.actor_id)throw new DomainError('unauthenticated',401);
 const located=await sqlFunction(pool,'mem.file_number_locator_internal',[parsed.data.number.toLowerCase().replace(/^f-/,'F-')]);
 if(!located) return{state:'not_found',number:parsed.data.number,coverage:'registered_file_number_map'};
 const body={project_id:located.project_id,material_id:located.material_id,...(located.version_id?{version_id:located.version_id}:{})};
 const head=await call(token,source,'file_number_head','mem.read',body);
 if(Object.hasOwn(request.body,'file_no')){const attributes=await call(token,source,'material_attributes','mem.read',{project_id:body.project_id,material_id:body.material_id});return{...head,...attributes};}
 return head;
 });
}
export function fileNumberTool(z){return{name:'hub.file.find',service:'mem',method:'POST',path:'/v2/materials/by-number',readOnly:true,description:'按F资料号查询当前版本或固定本地版本：F-1001278、F-1001278-001；兼容旧file_no/#号及material/version UUID。返回有权固定引用，版本序号持久分配，归档/删除/权限不重排。',schema:z.object({number:z.string().trim().regex(/^(?:F-[0-9]+(?:-[0-9]+)?|#?[0-9]+|[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})$/)}).strict()}}

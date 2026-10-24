/** Small controlled registered map. It locates only; current actor-scope lookup,
 * 744/source permission and full read must all pass. Never a Root credential. */
const project='6aedbc32-3768-47cc-a1e2-ff4297be5be7',system='legacy-mengstore-personal-demo';
const registered=new Set(['6M94j2RoxkoY','kZ3tXcnFYQsh']);
export function createRegisteredPrivateReader({nextIdentity,memberMem,readFull}){
 return async(caller,args)=>{
  let file_id=args?.file_id,ver=args?.ver;
  if(typeof file_id==='string'&&file_id.includes('/f/')){
   try{const u=new URL(file_id,'https://mengchu.example.invalid/'),m=u.pathname.match(/^\/f\/([^/]+)(?:\/([1-9][0-9]*))?\/?$/);
    if(m){file_id=decodeURIComponent(m[1]);if(ver===undefined){const n=m[2]??u.searchParams.get('ver');if(n!==null&&n!==undefined)ver=Number(n);}}
   }catch{}
  }
  if(!registered.has(file_id))return{handled:false};
  const numeric=ver!==undefined;if(numeric&&(!Number.isSafeInteger(ver)||ver<=0))throw Object.assign(Error('invalid_legacy_version'),{status:400,handled:true,allow_old_fallback:false});
  try{
   const auth=await nextIdentity(caller);
   if(!(auth?.actor_id??auth?.identity?.actor_id))throw Object.assign(Error('unauthenticated'),{status:401});
   const lookup=await memberMem(auth,'/v2/legacy/references/lookup',{project_id:project,source_system:system,source_id:file_id,
    field_path:numeric?'version:'+ver:'latest',actor_namespace:false});
   // This controlled ID is already migrated. A different actor has no actor-only
   // row: that is a refusal, never permission to go back to original private data.
   if(!lookup?.binding_id)throw Object.assign(Error('forbidden'),{status:403});
   const binding=await memberMem(auth,'/v2/legacy/references/resolve',{project_id:project,binding_id:lookup.binding_id});
   if(binding.state!=='available'||binding.reference_kind!==(numeric?'fixed':'latest')||!binding.fixed_ref)throw Object.assign(Error('mapped_private_reference_unavailable'),{status:503});
   const f=binding.fixed_ref;
   const resolved=await memberMem(auth,'/v2/references/resolve',{material_id:f.material_id,version_id:f.version_id,sha256:f.sha256});
   if(resolved.state!=='authorized_fixed_reference'||!resolved.fixed_ref)throw Object.assign(Error('forbidden'),{status:403});
   const result=await readFull(auth,{...resolved.fixed_ref});
   return{handled:true,result:{file_id,address:binding.original_address,size:result.size,
    content_type:result.text!==undefined?'text/plain; charset=utf-8':'application/octet-stream',
    ...(result.text!==undefined?{text:result.text}:{bytes_base64:result.bytes_base64}),
    source_version:{source_system:system,legacy_ver:numeric?ver:null,selection:numeric?'fixed':'latest_at_request',
     ...resolved.fixed_ref},old_personal_other_data_migrated:false}};
  }catch(e){
   const message=typeof e.message==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,100}$/.test(e.message)?e.message:'mapped_private_read_failed';
   throw Object.assign(Error(message),{status:e.status??503,handled:true,allow_old_fallback:false});
  }
 };
}

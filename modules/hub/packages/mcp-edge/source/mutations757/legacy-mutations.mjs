import{createHash}from'node:crypto';
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}',native=new RegExp('^m2_('+uuid+')$','i'),personal=new RegExp('^m2p_('+uuid+')_('+uuid+')$','i'),hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export class LegacyMutationError extends Error{constructor(code,status=409){super(code);Object.assign(this,{code,status,handled:true,allow_old_fallback:false});}}
export function fileId(value){if(typeof value!=='string'||!value)throw new LegacyMutationError('file_id_required',400);if(/^https?:\/\//.test(value)){let u;try{u=new URL(value);}catch{throw new LegacyMutationError('invalid_file_id',400);}value=u.pathname.split('/').filter(Boolean).at(-1);}if(typeof value!=='string'||!value||/[\x00\r\n]/.test(value))throw new LegacyMutationError('invalid_file_id',400);return value;}
export function createLegacyMutations({nextIdentity,memberMem,locateMaterial,resolveRegisteredFile,resolveSpace,isRegisteredFile,state,invocationKey}){
 if(![nextIdentity,memberMem,locateMaterial,resolveRegisteredFile,resolveSpace,isRegisteredFile,invocationKey].every(x=>typeof x==='function')||!state?.exclusive||!state?.load||!state?.save)throw Error('registered_mutation_ports_required');
 const call=async(a,path,body)=>{const r=await memberMem(a,path,body);if(r?.state==='failed'||r?.error_code)throw new LegacyMutationError(r.error_code??'current_API_failed',r.status??403);return r;};
 const current=async(a,id)=>{const n=id.match(native),p=id.match(personal);let material_id;if(n)material_id=n[1].toLowerCase();else if(p)material_id=p[2].toLowerCase();else material_id=(await resolveRegisteredFile(a,id)).material_id;if(!material_id)throw new LegacyMutationError('registered_material_required');const r=await locateMaterial(a,material_id);if(r.material_id!==material_id||!r.project_id||!r.fixed_ref)throw new LegacyMutationError('current_material_locator_required',503);return r;};
 async function intercept(name,caller,args){
  if(!['mengchu_move','mengchu_trash','mengchu_restore'].includes(name))return{handled:false};
  const id=fileId(args.file_id),known=native.test(id)||personal.test(id)||await isRegisteredFile(id);
  if(!known)return{handled:false};
  if(name==='mengchu_move'){
   if(!['shared','personal'].includes(args.space))throw new LegacyMutationError('registered_target_space_required',409);
   if(typeof args.path!=='string'||!args.path||args.path.length>1024||args.path.startsWith('/')||args.path.split('/').includes('..')||/[\x00\r\n]/.test(args.path))throw new LegacyMutationError('invalid_relative_path',400);
  }
  const a=await nextIdentity(caller),actor=a?.actor_id??a?.identity?.actor_id;if(!actor)throw new LegacyMutationError('current_member_required',401);
  const key=await invocationKey(caller,name,args);if(typeof key!=='string'||!key)throw new LegacyMutationError('stable_invocation_key_required');const op=hash([actor,name,key]),idem='legacy-mutation:'+op,fingerprint=hash([name,id,args.space??null,args.path??null]);
  return state.exclusive(op,async()=>{
   const loc=await current(a,id);let r=await state.load(op);if(r&&r.fingerprint!==fingerprint)throw new LegacyMutationError('idempotency_conflict');
   if(!r){
    if(name==='mengchu_move'){
     if(loc.state!=='available')throw new LegacyMutationError('restore_trashed_before_move');const target=await resolveSpace(a,args.space,loc);if(!target?.project_id)throw new LegacyMutationError('target_space_mapping_required');
     const placements=loc.placements??[];if(placements.length!==1)throw new LegacyMutationError('placement_selection_required');const placement=placements[0];
     if(target.project_id===loc.project_id)r={fingerprint,path:'/v2/placements/patch',body:{project_id:loc.project_id,placement_id:placement.placement_id,expected_revision:placement.revision,logical_path:args.path,idempotency_key:idem}};
     else r={fingerprint,path:'/v2/materials/move-scope',body:{project_id:loc.project_id,material_id:loc.material_id,target_project_id:target.project_id,placement_id:placement.placement_id,expected_scope_revision:loc.scope_revision,expected_content_revision:loc.content_revision,expected_metadata_revision:loc.metadata_revision,expected_version_id:loc.fixed_ref.version_id,expected_placement_revision:placement.revision,...(target.revision?{expected_target_project_revision:target.revision}:{}),logical_path:args.path,idempotency_key:idem,mode:'execute',judgment:{legacy_tool:'mengchu_move',space:args.space,semantic_decision:'caller_requested;current_authority_required'}}};
    }else r={fingerprint,path:'/v2/materials/trash',body:{project_id:loc.project_id,material_id:loc.material_id,expected_revision:loc.event_revision,restore:name==='mengchu_restore',idempotency_key:idem}};
    r.state='prepared';r.material_id=loc.material_id;r.file_id=id;await state.save(op,r);
   }
   // Never derive a new CAS tuple after a response loss. Same API+key reconciles the exact receipt.
   const replay=r.state==='completed';
   {
    // Current effect qualification is rechecked by the API even for receipt replay.
    r.state='request_pending';await state.save(op,r);
    try{r.receipt=await call(a,r.path,r.body);r.state='completed';await state.save(op,r);}catch(e){r.state='unknown_or_refused';r.error_code=e.code??'current_API_response_unknown';await state.save(op,r);throw e;}
   }
   const result={...r.receipt,file_id:id,material_id:r.material_id,observed_project_id:loc.project_id,...(r.body.target_project_id?{target_project_id:r.body.target_project_id}:{}),identity_preserved:true,fixed_history_preserved:true,physical_delete:false,receipt_replay:replay};
   return{handled:true,result};
  });
 }
 return{intercept};
}
export const mutationTools=[{name:'mengchu_move',description:'移动或改名已接管文件；固定ID/历史不变，当前权限与CAS，未迁入旧范围保原通道。',inputSchema:{type:'object',properties:{file_id:{type:'string'},space:{type:'string'},path:{type:'string'}},required:['file_id','space','path']}},{name:'mengchu_trash',description:'当前已接管文件软删除至回收态，不物理删除；当前权限与CAS。',inputSchema:{type:'object',properties:{file_id:{type:'string'}},required:['file_id']}},{name:'mengchu_restore',description:'恢复已接管文件软删除状态，原固定ID和历史保持。',inputSchema:{type:'object',properties:{file_id:{type:'string'}},required:['file_id']}}];

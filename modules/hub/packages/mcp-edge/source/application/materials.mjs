import{randomUUID,createHash}from'node:crypto';
const field=(name,description,properties,required=[])=>({name,description,inputSchema:{type:'object',properties,required,...(properties.material_id&&properties.file_no?{anyOf:[{required:['material_id']},{required:['file_no']}]}:{})}});
const target={file_no:{type:'string'},material_id:{type:'string',format:'uuid'},project_id:{type:'string',format:'uuid'}};
export const materialTools=[
 field('hub.material.usage_candidates','读取项目近期使用候选，Agent依据调用频率自主调整存储类型，重要性不随次数自动变化。',{project_id:{type:'string'},window_days:{type:'integer'},limit:{type:'integer'}},['project_id']),
 field('hub.material.by_number','按新文件数字编号读取本人有权资料的属性与固定引用；旧文件编号继续使用原有入口。',{file_no:{type:'string'}},['file_no']),
 field('hub.material.attributes','读取基础属性和JSONB扩展属性；可合并更新属性、三级重要性和文件格式。编号、权限、固定版本不由普通属性改变。',{...target,attributes:{type:'object'},remove_attributes:{type:'array',items:{type:'string'}},importance_level:{type:'integer',enum:[1,2,3]},file_format:{type:'string'},reason:{},expected_revision:{type:'integer',minimum:0},replace_attributes:{type:'boolean'},manual_special:{type:'boolean'},human_instruction:{type:'string'},idempotency_key:{type:'string'}},[]),
 field('hub.material.usage','查看近期实际正文读取和Agent声明的采用/复用，供Agent自主调整存储；重要性依据内容和属性；可记录明确业务使用。列表和简介检索不计正文使用。',{...target,window_days:{type:'integer'},record_kind:{enum:['adopted','reused']},version_id:{type:'string'},event_key:{type:'string'},reason:{type:'string'},work_item_id:{type:'string'}},[]),
 field('hub.material.share','按当前项目管理权定向授权单份文件给成员，默认只读直到撤销；允许修改需access:edit。涵盖该文件所有版本，不开放其他个人文件。',{...target,recipient_id:{type:'string'},recipient_name:{type:'string'},access:{enum:['read','edit']},expires_at:{type:'string'},until_revoked:{type:'boolean'},idempotency_key:{type:'string'}},[]),
 field('hub.material.shares','查看本人可管理文件的定向授权记录。',target,[]),
 field('hub.material.share_revoke','撤销指定文件共享授权；不撤销对方其他已有权限，也不能召回已下载副本。',{...target,share_id:{type:'string'},idempotency_key:{type:'string'}},['share_id']),
 field('hub.material.shared','列出别人明确共享给本人的文件引用；仍受本人软件范围约束。',{})
];
const naming=/^[a-z][a-z0-9_]{0,79}$/;
const canonical=x=>x&&typeof x==='object'?(Array.isArray(x)?'['+x.map(canonical).join(',')+']':'{'+Object.keys(x).sort().filter(k=>x[k]!==undefined).map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}'):JSON.stringify(x);
const digest=x=>createHash('sha256').update(canonical(x)).digest('hex');
export function createMaterialTools({memberMem,memberHufu,error,state}){
 return async(name,auth,args,req)=>{
  if(name==='hub.material.usage_candidates')return memberMem(auth,'/v2/materials/usage-candidates',{project_id:args.project_id,...(args.window_days?{window_days:args.window_days}:{}),...(args.limit?{limit:args.limit}:{})});
  if(name==='hub.material.by_number')return memberMem(auth,'/v2/materials/by-number',{file_no:String(args.file_no)});
  if(name==='hub.material.shared')return memberHufu(auth,'/v2/material-shares/received',{});
  const numbered=args.file_no!==undefined?await memberMem(auth,'/v2/materials/by-number',{file_no:String(args.file_no)}):null;
  if(numbered&&args.material_id&&numbered.material_id!==args.material_id)throw error('material_reference_mismatch',409);
  const material_id=args.material_id||numbered?.material_id;
  if(!material_id)throw error('material_id_or_file_no_required',400);
  const loc=await memberMem(auth,'/v2/materials/locate',{material_id,...(args.version_id?{version_id:args.version_id}:{})});
  const scope={project_id:loc.project_id,material_id:loc.material_id};
  if(args.project_id&&args.project_id!==scope.project_id)throw error('permission_project_mismatch',409);
  if(name==='hub.material.attributes'){
   const before=await memberMem(auth,'/v2/materials/attributes',scope);
   if(args.attributes===undefined&&args.importance_level===undefined&&args.file_format===undefined&&args.remove_attributes===undefined&&args.manual_special===undefined)return before;
   if(args.remove_attributes!==undefined&&(!Array.isArray(args.remove_attributes)||args.remove_attributes.some(k=>typeof k!=='string')))throw error('remove_attributes_array_required');
   if(args.attributes!==undefined&&(!args.attributes||Array.isArray(args.attributes)||typeof args.attributes!=='object'))throw error('attributes_object_required',400);
   for(const key of [...Object.keys(args.attributes||{}),...(args.remove_attributes||[])])if(!naming.test(key))throw Object.assign(error('attribute_key_requires_snake_case',400),{detail:{key,next_step:'use_stable_snake_case_keys;Chinese_values_and_display_names_are_allowed'}});
   if(args.importance_level!==undefined&&![1,2,3].includes(args.importance_level))throw error('invalid_importance_level',400);
   if(args.expected_revision!==undefined&&(!Number.isSafeInteger(args.expected_revision)||args.expected_revision<0))throw error('invalid_expected_revision');
   if(args.replace_attributes!==undefined&&typeof args.replace_attributes!=='boolean')throw error('invalid_attributes_mode');
   if(args.manual_special!==undefined&&(typeof args.manual_special!=='boolean'||typeof args.human_instruction!=='string'||!args.human_instruction.trim()||args.human_instruction.length>4000))throw error('manual_instruction_required');
   if(args.manual_special===true&&args.importance_level!==undefined&&args.importance_level!==1)throw error('special_designation_requires_level_one');
   const key=args.idempotency_key||randomUUID();if(typeof key!=='string'||key.length>200)throw error('invalid_idempotency_key');
   const issuer={actor_id:auth.identity.actor_id,client_id:auth.identity.client_id},journalId=digest({issuer,key,tool:name});
   const apply=async()=>{
    const signature=digest({scope,attributes:args.attributes,remove_attributes:args.remove_attributes,importance_level:args.importance_level,file_format:args.file_format,reason:args.reason,expected_revision:args.expected_revision,replace_attributes:args.replace_attributes,manual_special:args.manual_special,human_instruction:args.human_instruction});
    let j=state?await state.load(journalId):null;if(j&&j.signature!==signature)throw error('idempotency_key_reused_for_different_input',409);
    const save=async()=>{if(state)await state.save(journalId,j);};
    if(!j){
     if(args.expected_revision!==undefined&&args.expected_revision!==before.metadata_revision)throw error('metadata_changed_refresh',409);
     j={signature,judged_at:new Date().toISOString(),base:{metadata_revision:before.metadata_revision,properties:before.properties||{}}};
     if(args.manual_special!==undefined){const reason=typeof args.reason==='string'?args.reason:undefined;if(reason!==undefined&&reason.length>2000)throw error('designation_reason_too_long');j.designation_request={...scope,special:args.manual_special,human_instruction:args.human_instruction,...(reason!==undefined?{reason}:{}),importance_level:args.manual_special?1:args.importance_level||before.core.importance_level||1,expected_revision:before.metadata_revision,idempotency_key:key.length<=188?key+':designation':'designation:'+digest(key)};}
     await save();
    }
    if(!j.request&&!j.designation_request&&!j.base)throw error('incomplete_attribute_intent_requires_review',409);
    let effective=j.base||before,designation;
    try{
     if(j.designation_request){designation=await memberMem(auth,'/v2/materials/importance-designate',j.designation_request);effective=await memberMem(auth,'/v2/materials/attributes',scope);if(!j.request&&effective.metadata_revision!==designation.metadata_revision)throw error('metadata_changed_after_designation',409);}
     if(!j.request){
      const prior=effective.properties||{},extra={...(args.replace_attributes?{}:prior.attributes||{}),...(args.attributes||{})};for(const key of args.remove_attributes||[])delete extra[key];
      const properties={attributes:extra,...(args.file_format!==undefined?{core:{...(prior.core||{}),file_format:String(args.file_format).toLowerCase().replace(/^\./,'')}}:{}),...(args.importance_level!==undefined?{governance:{...(prior.governance||{}),importance_level:args.importance_level,important:args.importance_level===1,reason:args.reason??prior.governance?.reason??null,judged_by:auth.identity.actor_id,judged_at:j.judged_at}}:{})};
      j.request={...scope,expected_revision:effective.metadata_revision,properties,idempotency_key:key};delete j.base;await save();
     }
     // The original native request rechecks write authorization and CAS/replay semantics.
     const saved=await memberMem(auth,'/v2/materials/metadata',j.request);
     return{...await memberMem(auth,'/v2/materials/attributes',scope),metadata:saved,...(designation?{designation}:{}),idempotency_key:key,physical_transition:'not_requested;use_hub.material.govern_for_storage',authority_unchanged:true};
    }catch(e){e.detail={...(e.detail||{}),idempotency_key:key,...(designation?{designation_saved:designation}:{}),recovery:{tool:name,arguments:{...args,idempotency_key:key},mode:'resume_original_intent'}};throw e;}
   };
   return state?state.exclusive(journalId,apply):apply();
  }
  if(name==='hub.material.usage'){
   let recorded=null;if(args.record_kind){if(!['adopted','reused'].includes(args.record_kind))throw error('invalid_use_kind');recorded=await memberMem(auth,'/v2/materials/use',{...scope,version_id:args.version_id||loc.fixed_ref.version_id,event_key:args.event_key||randomUUID(),kind:args.record_kind,...(args.reason?{reason:args.reason}:{}),...(args.work_item_id?{work_item_id:args.work_item_id}:{})});}
   return{...await memberMem(auth,'/v2/materials/usage',{...scope,window_days:args.window_days||30}),...(recorded?{recorded}: {})};
  }
  const command={'hub.material.share':'grant','hub.material.shares':'list','hub.material.share_revoke':'revoke'}[name];if(!command)throw error('unknown_material_tool');
  const body={...scope};for(const k of ['recipient_id','recipient_name','access','expires_at','until_revoked','share_id','idempotency_key'])if(args[k]!==undefined)body[k]=args[k];
  return memberHufu(auth,'/v2/material-shares/'+command,body);
 };
}

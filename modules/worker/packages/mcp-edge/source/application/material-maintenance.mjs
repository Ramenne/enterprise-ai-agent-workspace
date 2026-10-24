import {randomUUID} from 'node:crypto';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fields={attributes:['material_id','file_no','project_id','attributes','remove_attributes','importance_level','file_format','reason','expected_revision','manual_special','human_instruction','replace_attributes','idempotency_key'],description:['material_id','version_id','text','expected_revision','idempotency_key'],index:['material_id','version_id','idempotency_key'],storage:['material_id','version_id','storage_tier','reason','idempotency_key'],restore:['material_id','version_id','idempotency_key'], 'restore-status':['material_id','version_id','operation_id'],semantic:['material_id','project_id','text']};
/** HTTP and portal presentation adapters call the same hosted applications. */
export function createMaterialMaintenance({govern,materials,mem,invokeNext,error}){
 return async function handle(auth,operation,b,req){
  if(operation==='govern')return govern(auth,b,req);
  if(!fields[operation]||!b||Array.isArray(b)||typeof b!=='object'||Object.keys(b).some(k=>!fields[operation].includes(k)))throw error('invalid_material_maintenance_input');
  if(operation==='attributes')return materials('hub.material.attributes',auth,b,req);
  if(operation==='semantic'&&b.project_id){if(!uuid.test(b.project_id)||typeof b.text!=='string'||!b.text.trim())throw error('project_and_query_required');return invokeNext(auth,'mem.semantic.query',{project_id:b.project_id,text:b.text,top_k:30},req);}
  if(!uuid.test(b.material_id||'')||b.version_id!==undefined&&!uuid.test(b.version_id))throw error('material_id_required');
  const target={material_id:b.material_id,...(b.version_id?{version_id:b.version_id}:{}),...(b.idempotency_key?{idempotency_key:b.idempotency_key}:{})};
  if(operation==='description'){
   if(typeof b.text!=='string'||b.text.length>10000)throw error('description_text_required');
   const r=await govern(auth,{...target,note:b.text,index:true,...(b.expected_revision!==undefined?{expected_description_revision:b.expected_revision}:{})},req);
   return{saved:r.description,index:r.index,fixed_ref:r.fixed_ref,idempotency_key:r.idempotency_key,completion_state:r.completion_state,pending_steps:r.pending_steps,...(r.recovery?{recovery:r.recovery}:{}),...(r.metadata?{metadata:r.metadata}:{})};
  }
  if(operation==='storage'&&!['standard','infrequent','archive','deep_archive'].includes(b.storage_tier))throw error('invalid_storage_tier');
  if(operation==='storage')return govern(auth,{...target,storage_tier:b.storage_tier,reason:b.reason||'成员根据使用需要调整存储，重要性保持不变'},req);
  const loc=await mem(auth,'/v2/materials/locate',{material_id:b.material_id,...(b.version_id?{version_id:b.version_id}:{})}),scope={project_id:loc.project_id,material_id:loc.material_id,version_id:loc.fixed_ref.version_id};
  if(operation==='index')return invokeNext(auth,'mem.semantic.index_fixed',{project_id:scope.project_id,fixed_ref:{material_id:scope.material_id,version_id:scope.version_id,sha256:loc.fixed_ref.sha256},...(b.idempotency_key?{idempotency_key:b.idempotency_key}:{})},req);
  if(operation==='restore'){const key=b.idempotency_key||randomUUID();return{...await mem(auth,'/v2/objects/storage-tier/restore',{...scope,days:7,retrieval:'Standard',idempotency_key:key}),idempotency_key:key};}
  if(operation==='restore-status'){if(!uuid.test(b.operation_id||''))throw error('operation_id_required');return mem(auth,'/v2/objects/storage-tier/status',{...scope,command:'restore',operation_id:b.operation_id});}
  return invokeNext(auth,'mem.semantic.query',{project_id:scope.project_id,text:String(b.text||''),top_k:20},req);
 };
}

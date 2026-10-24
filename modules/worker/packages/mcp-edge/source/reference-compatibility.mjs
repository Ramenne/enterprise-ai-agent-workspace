// Preserve reference identity and tolerate descriptive metadata returned by
// the platform. Permission targets, version IDs and digests are never guessed.
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// A project_id attached to a fixed reference is display metadata. Actual
// source authority is derived by the backend from the unchanged fixed triple.
const descriptive=new Set(['size','bytes','byte_size','file_no','version_no','display_name','name','filename','mime_type','created_at','updated_at','storage_class','project_id','display_no','file_display_no','local_version_no']);
export function compatibleReference(ref){
 if(!ref||typeof ref!=='object'||Array.isArray(ref))return ref;
 if(!['material_id','version_id','sha256'].every(k=>typeof ref[k]==='string'))return ref;
 return Object.fromEntries(Object.entries(ref).filter(([k])=>!descriptive.has(k)));
}
export function compatibleWorkArguments(name,input){
 if(['hub2_api','hub_api'].includes(name)&&input?.system==='v8'&&input?.method==='POST'){
  const route={'/v2/work-items/save':'v8.work.save','/v2/work-items/commit':'v8.work.commit','/v2/adoptions':'v8.adoption.set','/v2/contexts/prepare':'v8.context.prepare','/v2/contexts/materialize':'v8.context.materialize','/v2/handoffs':'v8.handoff.record'}[input.path];
  if(route&&input.body&&typeof input.body==='object')return {...input,body:compatibleWorkArguments(route,input.body)};
 }
 if(!/^v8\.(work\.(save|commit)|adoption\.set|context\.(prepare|materialize)|handoff\.record|experience\.(publish|feedback))$/.test(name))return input;
 const a={...input};
 if(/^v8\.work\.(save|commit)$/.test(name)){
  const item=a.work_item&&typeof a.work_item==='object'&&!Array.isArray(a.work_item)?a.work_item:null;
  const candidates=[a.work_id,a.id,item?.work_item_id,item?.id].filter(v=>v!==undefined);const alias=candidates[0];
  if(candidates.some(v=>typeof v!=='string'||!uuid.test(v)))throw Error('invalid_work_item_reference');
  if(candidates.some(v=>v.toLowerCase()!==alias.toLowerCase()))throw Error('conflicting_work_item_reference');
  if(alias!==undefined){
   if(typeof alias!=='string'||!uuid.test(alias))throw Error('invalid_work_item_reference');
   if(a.work_item_id&&a.work_item_id.toLowerCase()!==alias.toLowerCase())throw Error('conflicting_work_item_reference');
   a.work_item_id??=alias;delete a.id;delete a.work_id;
  }
  if(item){
   if(item.project_id!==undefined&&(typeof item.project_id!=='string'||!uuid.test(item.project_id)))throw Error('invalid_work_project_reference');
   if(a.project_id&&item.project_id&&typeof a.project_id==='string'&&a.project_id.toLowerCase()!==item.project_id.toLowerCase())throw Error('conflicting_work_project_reference');
   a.project_id??=item.project_id;a.expected_revision??=item.revision;delete a.work_item;
  }
  if(typeof a.expected_revision==='string'&&/^[1-9][0-9]*$/.test(a.expected_revision)&&Number.isSafeInteger(Number(a.expected_revision)))a.expected_revision=Number(a.expected_revision);
 }
 if(Array.isArray(a.outputs))a.outputs=a.outputs.map(compatibleReference);
 if(Array.isArray(a.fixed_refs))a.fixed_refs=a.fixed_refs.map(compatibleReference);
 if(a.fixed_ref)a.fixed_ref=compatibleReference(a.fixed_ref);
 if(a.context&&typeof a.context==='object'&&Array.isArray(a.context.fixed_refs))a.context={...a.context,fixed_refs:a.context.fixed_refs.map(compatibleReference)};
 if(Array.isArray(a.related))a.related=a.related.map(r=>r?.basis&&Array.isArray(r.basis.refs)?{...r,basis:{...r.basis,refs:r.basis.refs.map(b=>b?.fixed_ref?{...b,fixed_ref:compatibleReference(b.fixed_ref)}:b)}}:r);
 return a;
}

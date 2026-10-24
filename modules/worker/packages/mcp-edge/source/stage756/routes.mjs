const shared='d5027a95-f21b-483d-a9f1-06a91db45551';
const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const denied=(code,status=403)=>{throw Object.assign(Error(code),{status,handled:true,allow_old_fallback:false});};
/** registered entries: file_id,path,project_id,source_system,space,fenced.
 * Root uses its EXISTING catalogs/control (82shared+2private). No new DB truth.
 * resolvePersonalProject is the existing current-caller personal selector. */
export function createStageRoutes({registered,nextIdentity,memberMem,resolvePersonalProject}){
 const mem=async(a,p,b)=>{const x=await memberMem(a,p,b);if(x?.error_code)denied(x.error_code,x.status??403);return x;};
 const normalize=id=>{try{if(id.includes('/f/')){const u=new URL(id,'https://hufu.example.invalid/'),m=u.pathname.match(/^\/f\/([^/]+)(?:\/([1-9][0-9]*))?\/?$/);if(m)return{id:decodeURIComponent(m[1]),ver:m[2]?Number(m[2]):u.searchParams.has('ver')?Number(u.searchParams.get('ver')):null};}}catch{}return{id,ver:null};};
 async function locateFile(caller,value){
  if(typeof value!=='string')return{handled:false};const {id,ver}=normalize(value),old=registered.find(x=>x.file_id===id&&x.fenced);
  const native=id.match(new RegExp('^m2_('+uuid+')$','i')),personal=id.match(new RegExp('^m2p_('+uuid+')_('+uuid+')$','i'));
  if(!old&&!native&&!personal)return{handled:false};const a=await nextIdentity(caller);let fixed;
  if(old){if(ver!==null&&(!Number.isSafeInteger(ver)||ver<1))denied('invalid_legacy_version',400);
   const l=await mem(a,'/v2/legacy/references/lookup',{project_id:old.project_id,source_system:old.source_system,source_id:id,field_path:ver===null?'latest':'version:'+ver,actor_namespace:false});if(!l.binding_id)denied('forbidden');
   const r=await mem(a,'/v2/legacy/references/resolve',{project_id:old.project_id,binding_id:l.binding_id});if(r.state!=='available'||!r.fixed_ref)denied('registered_reference_unavailable',503);fixed=r.fixed_ref;
  }else{if(ver!==null)denied('native_numeric_version_invalid',400);const material_id=personal?personal[2]:native[1];const h=await mem(a,'/v2/materials/locate',{material_id});if(h.state!=='available'||!h.fixed_ref)denied('no_published_original',409);fixed={...h.fixed_ref,project_id:h.project_id};}
  const r=await mem(a,'/v2/references/resolve',{material_id:fixed.material_id,version_id:fixed.version_id,sha256:fixed.sha256});if(!r.fixed_ref)denied('forbidden');return{handled:true,fixed_ref:r.fixed_ref};
 }
 async function locateTarget(caller,args){
  if(!['shared','personal'].includes(args.space))return{handled:false};const p=args.path;
  if(typeof p!=='string'||!p||p.startsWith('/')||p.split('/').some(x=>!x||x==='.'||x==='..')||/[\x00\r\n]/.test(p))denied('invalid_path',400);
  let old=registered.find(x=>x.space===args.space&&x.path===p);if(old&&!old.fenced)return{handled:false};
  const a=await nextIdentity(caller);let project_id,material_id,actualPath=p;
  if(old){const current=await mem(a,'/v2/materials/locate',{material_id:old.material_id});const placement=current.placements?.length===1?current.placements[0]:null;
   if(current.project_id!==old.project_id||!placement||![p,'旧共享资料/'+p].includes(placement.logical_path)){old=null;}
   else{project_id=current.project_id;material_id=current.material_id;actualPath=placement.logical_path;}}
  if(!old&&args.space==='shared')project_id=shared;
  else if(!old){const selected=await resolvePersonalProject(caller,args);if(!selected?.handled)return{handled:false};project_id=selected.project_id;}
  if(!material_id){const snapshot=await mem(a,'/v2/material-enumerations',{project_id});let cursor=0,ids=[];
   do{const page=await mem(a,'/v2/material-enumerations/page',{project_id,snapshot_id:snapshot.snapshot_id,cursor,limit:100});for(const item of page.items??[])if(item.logical_path===p||(item.placements??[]).some(x=>x.logical_path===p))ids.push(item.material_id);cursor=page.next_cursor;}while(cursor!==null&&cursor!==undefined);
   ids=[...new Set(ids)];if(ids.length>1)denied('ambiguous_path_choose_material',409);material_id=ids[0];}
  const h=material_id?await mem(a,'/v2/materials/locate',{material_id}):null;
  if(h&&h.project_id!==project_id)denied('target_project_changed',409);
  const locator=material_id?(args.space==='personal'?`m2p_${project_id}_${material_id}`:'m2_'+material_id):null;
  return{handled:true,space:args.space,project_id,path:actualPath,material_id,public_file_id:old?.file_id??locator,metadata:material_id?{file_id:locator,expected_revision:h.content_revision,expected_version_id:h.fixed_ref.version_id}:{}};
 }
 return{locateFile,locateTarget};
}

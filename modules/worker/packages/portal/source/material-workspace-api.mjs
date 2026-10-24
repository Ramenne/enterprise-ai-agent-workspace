import{randomUUID}from'node:crypto';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const filename=p=>(p||'未命名资料').split('/').filter(Boolean).at(-1);
export function createMaterialWorkspace({pageToken,call,observeInventory=()=>{}}){
 const mem=(token,path,b)=>call('http://127.0.0.1:4612'+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(b)});
 const usecase=(token,path,b)=>call('http://127.0.0.1:8939/v2/usecases/'+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(b)});
 const validate=id=>{if(!uuid.test(id||''))throw Object.assign(Error('material_id_required'),{status:400});};
 async function inventory(me){
  try{observeInventory();}catch{}
  const token=await pageToken(me),projects=[];let cursor;
  do{const r=await call('http://127.0.0.1:4613/v2/projects/search',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({limit:100,...(cursor?{cursor}:{})})});projects.push(...r.items);cursor=r.next_cursor;}while(cursor&&projects.length<500);
  const output=[],warnings=[];let next=0;
  await Promise.all(Array.from({length:3},async()=>{while(next<projects.length){const p=projects[next++],id=p.project_id||p.id;try{const snap=await mem(token,'/v2/material-enumerations',{project_id:id});let offset=0;do{const page=await mem(token,'/v2/material-enumerations/page-display',{project_id:id,snapshot_id:snap.snapshot_id,cursor:offset,limit:100});for(const row of page.items||[]){const path=row.placements?.[0]?.logical_path||row.logical_path||'未命名资料';output.push({...row,project_id:id,project_name:p.title,visibility:p.visibility||'unknown',path,name:filename(path),attributes:row.properties?.attributes||{},governance:row.properties?.governance||{}});}offset=page.next_cursor;}while(offset!==null&&offset!==undefined);}catch(e){warnings.push({project_id:id,project_name:p.title,error:e.message});}}}));
  output.sort((a,b)=>Number(a.file_no||0)-Number(b.file_no||0));
  return{state:'loaded',items:output,projects:projects.map(p=>({id:p.project_id||p.id,title:p.title,visibility:p.visibility})),coverage:{complete:!cursor&&!warnings.length,scope:'current_member_authorized_active_materials',warnings,project_cursor:cursor||null},observed_at:new Date().toISOString()};
 }
 async function handle(me,operation,b={}){
  if(operation==='inventory')return inventory(me);
  if(['list','counts','rows'].includes(operation))return usecase(await pageToken(me),'materials/'+operation,b);
  if(operation==='upload')return usecase(await pageToken(me),'documents/upload',b);
  if(operation==='detail')return usecase(await pageToken(me),'materials/detail',b);
  if(operation==='preview')return usecase(await pageToken(me),'documents/read',{material_id:b.material_id,...(b.version_id?{version_id:b.version_id}:{}),...(b.encoding==='base64'?{encoding:'base64'}:{})});
  if(['attributes','description','index','storage','restore','restore-status','semantic'].includes(operation)){const payload={...b};if(operation==='attributes'){payload.replace_attributes=true;if(payload.importance_level===0)delete payload.importance_level;}return usecase(await pageToken(me),'materials/'+operation,payload);}
  if(operation!=='write')throw Object.assign(Error('unknown_operation'),{status:404});
  validate(b.material_id);const token=await pageToken(me),loc=await mem(token,'/v2/materials/locate',{material_id:b.material_id,...(b.version_id?{version_id:b.version_id}:{})});
  const scope={project_id:loc.project_id,material_id:loc.material_id};

  if(operation==='write'){if(typeof b.text!=='string'||b.text.length>600000||!Number.isInteger(b.base_revision)||!uuid.test(b.base_version_id||''))throw Object.assign(Error('text_and_base_required'),{status:400});return usecase(token,'documents/save',{...scope,path:String(b.path||''),text:b.text,base_version_id:b.base_version_id,base_revision:b.base_revision,...(b.note?{note:b.note}:{}),register_work:false,idempotency_key:b.idempotency_key||randomUUID()});}
  throw Object.assign(Error('unknown_operation'),{status:404});
 }
 async function semantic(me,b){return usecase(await pageToken(me),'materials/semantic',b);}
 async function download(me,id,version,requestedName){validate(id);const token=await pageToken(me),loc=await mem(token,'/v2/materials/locate',{material_id:id,...(version?{version_id:version}:{})});const r=await fetch('http://127.0.0.1:4612/v2/files/read',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({project_id:loc.project_id,material_id:id,version_id:loc.fixed_ref.version_id}),signal:AbortSignal.timeout(300000)});if(!r.ok){const e=await r.json().catch(()=>({}));throw Object.assign(Error(e.error_code||'download_unavailable'),{status:r.status});}return{response:r,name:filename(loc.placements?.[0]?.logical_path||(typeof requestedName==='string'&&requestedName.length<240?requestedName:'资料-'+id))};}
 return{handle,semantic,download};
}

/** Alias cache locates a material only. Every live fact is current-member API. */
export function createCurrentPaths({memberMem,aliases,originalPaths=[]}){
 const byMaterial=new Map(),byId=new Map();for(const x of aliases){byId.set(x.file_id,x.material_id);if(x.selection==='latest'||!byMaterial.has(x.material_id))byMaterial.set(x.material_id,x.file_id);}
 const mem=async(a,path,body)=>{const r=await memberMem(a,path,body);if(r?.error_code)throw Object.assign(Error(r.error_code),{status:r.status??403,handled:true,allow_old_fallback:false});return r;};
 const locate=(a,material_id)=>mem(a,'/v2/materials/locate',{material_id});
 async function rows(a,project_id){const s=await mem(a,'/v2/material-enumerations',{project_id});let cursor=0;const all=[];
  do{const p=await mem(a,'/v2/material-enumerations/page',{project_id,snapshot_id:s.snapshot_id,cursor,limit:100});
   for(const item of p.items??[]){const h=await locate(a,item.material_id);if(h.state!=='available'||h.project_id!==project_id||!h.fixed_ref)continue;
    const paths=[...new Set((h.placements??[]).filter(x=>!x.project_id||x.project_id===project_id).map(x=>x.logical_path).filter(Boolean))];
    for(const path of paths)all.push({path,material_id:item.material_id,file_id:byMaterial.get(item.material_id),head:h,fixed_ref:h.fixed_ref});}
   cursor=p.next_cursor;
  }while(cursor!==null&&cursor!==undefined);return all;
 }
 async function find(a,project_id,path,prefix=''){
  const paths=[...new Set([path,...(prefix?[prefix+path]:[])])];
  const result=await mem(a,'/v2/materials/by-path',{project_id,paths}),found=result.items||[],ids=[...new Set(found.map(x=>x.material_id))];
  if(ids.length>1)throw Object.assign(Error('ambiguous_current_path'),{status:409,handled:true,allow_old_fallback:false});
  if(!ids.length)return null;
  const h=await locate(a,ids[0]);
  if(h.state!=='available'||h.project_id!==project_id||!h.fixed_ref)throw Object.assign(Error('current_path_changed_retry'),{status:409,handled:true,allow_old_fallback:false});
  const livePaths=new Set((h.placements||[]).filter(x=>!x.project_id||x.project_id===project_id).map(x=>x.logical_path));
  const selected=found.find(x=>paths.includes(x.logical_path)&&livePaths.has(x.logical_path));
  if(!selected)throw Object.assign(Error('current_path_changed_retry'),{status:409,handled:true,allow_old_fallback:false});
  return{path:selected.logical_path,material_id:ids[0],file_id:byMaterial.get(ids[0]),head:h,fixed_ref:h.fixed_ref};
 }
 return{locate,rows,find,materialForId:id=>byId.get(id),aliasForMaterial:id=>byMaterial.get(id),isKnownOriginalPath:path=>originalPaths.includes(path)};
}

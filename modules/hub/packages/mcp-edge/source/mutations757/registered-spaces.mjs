/** Only existing registered metadata chooses target namespace. Never caller Actor. */
export function createRegisteredSpaces({sharedControl,personalControl,memberV8}){
 const call=async(a,path,body)=>{const r=await memberV8(a,path,body);if(r.state==='failed'||r.error_code)throw Object.assign(Error('space_permission_or_API_required'),{status:403});return r;};
 return async(a,space,loc)=>{
  if(space==='shared'){if(sharedControl.mode!=='next_shared_mcp'||!sharedControl.project_id)throw Error('shared_space_unregistered');const r=await call(a,'/v2/projects/read',{project_id:sharedControl.project_id});return{project_id:r.project.id,revision:r.project.revision};}
  if(space!=='personal'||personalControl.mode!=='native_personal_new')throw Error('personal_space_unregistered');
  const actor=a.actor_id??a.identity?.actor_id;const source=await call(a,'/v2/projects/read',{project_id:loc.project_id});if(source.project?.visibility==='personal'&&source.project.owner_id===actor)return{project_id:source.project.id,revision:source.project.revision};
  const title=personalControl.default_project_title??'我的个人资料';let cursor;const found=[];
  do{const page=await call(a,'/v2/projects/search',{query:title,limit:100,...(cursor?{cursor}:{})});for(const row of page.items??[]){if(row.title!==title||row.kind!=='project'||row.visibility!=='personal'||row.owner_id!==actor)continue;const p=(await call(a,'/v2/projects/read',{project_id:row.project_id??row.id})).project;if(p?.owner_id===actor&&p.visibility==='personal'&&p.state==='active')found.push(p);}cursor=page.next_cursor;}while(cursor);
  if(found.length!==1)throw Object.assign(Error(found.length?'personal_space_ambiguous':'own_personal_space_not_initialized'),{status:409});return{project_id:found[0].id,revision:found[0].revision};
 };
}

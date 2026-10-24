// Input is the current member-authorized project directory, never an unscoped
// database list. Visibility labels describe projects; they do not grant access.
export function authorizedProjects(rows,_actor=""){
 const seen=new Set();return rows.filter(p=>{
  const id=p.project_id||p.id;
  if(!id||seen.has(id)||p.state==='deleted'||p.can_read===false)return false;
  seen.add(id);return true;
 }).map(p=>({...p,project_id:p.project_id||p.id}));
}
export function workRow(w){return {...w,work_item_id:w.work_item_id||w.id,short_no:w.short_no,goal:w.goal||w.title||'未命名工作'};}
export function numberLabel(value){return Number.isSafeInteger(Number(value))&&Number(value)>0?'#'+value:'';}
export function fileName(file){const path=file.logical_path||file.placements?.[0]?.logical_path||'';return file.title||file.name||decodeName(path.split('/').at(-1))||file.display_no||file.fixed_ref?.display_no||'未命名文件';}
function decodeName(s){try{return decodeURIComponent(s||'');}catch{return s;}}
export function propertyRows(properties){return Object.entries(properties||{}).filter(([,v])=>['string','number','boolean'].includes(typeof v)).map(([key,value])=>({key,value:String(value)}));}

// Readability and personal ownership are different facts. A current authorized
// team is relevant through membership/grant; public foreign personal is not mine.
export function myProjects(rows,actor){
 return authorizedProjects(rows).filter(p=>p.visibility==='team'&&(p.owner_id===actor||p.manager_id===actor||p._member_related===true)||['personal','private'].includes(p.visibility)&&p.owner_id===actor);
}
export function projectScopeValue(p){return p?.visibility==='team'?'team':['personal','private'].includes(p?.visibility)?'personal':'';}
export function projectScopeLabel(p){return projectScopeValue(p)==='team'?'团队项目':projectScopeValue(p)==='personal'?'个人项目':'项目';}

export function projectPickerOptions(projects){
 const rank=p=>projectScopeValue(p)==='personal'?0:projectScopeValue(p)==='team'?1:2;
 return [...projects].sort((a,b)=>rank(a)-rank(b)).map(p=>({value:p.project_id||p.id,label:p.title,meta:projectScopeValue(p)==='personal'?'个人':projectScopeValue(p)==='team'?'团队':''}));
}

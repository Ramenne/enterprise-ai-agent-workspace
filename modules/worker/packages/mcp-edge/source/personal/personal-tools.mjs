import{createHash}from'node:crypto';
const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const uri=new RegExp('^m2p_('+uuid+')_('+uuid+')$','i');
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export class PersonalToolError extends Error{constructor(code,status=503,detail){super(code);Object.assign(this,{code,status,detail,handled:true,allow_old_fallback:false});}}
export function parsePersonalLocator(value){const m=typeof value==='string'?value.match(uri):null;return m?{project_id:m[1],material_id:m[2]}:null;}
export function createPersonalTools({control,nextIdentity,memberV8,memberMem,saveDocument,readFull,makeClient,state,invocationKey,
 hasOriginalCredential,oldPersonalPathExists,addressFor,indexDescription,searchOriginalPersonal,currentPaths}){
 const enabled=()=>control.mode==='native_personal_new';
 const owner=a=>a.actor_id??a.identity?.actor_id;
 const identity=async caller=>{const a=await nextIdentity(caller);if(!owner(a))throw new PersonalToolError('native_member_registration_or_login_required',401);return a;};
 const call=async(fn,a,path,b)=>{const r=await fn(a,path,b);if(r?.error_code||r?.state==='failed')throw new PersonalToolError(r.error_code??'current_API_refused',r.status??403);return r;};
 const v8=(a,p,b)=>call(memberV8,a,p,b),mem=(a,p,b)=>call(memberMem,a,p,b);
 const key=async(caller,a,name,args)=>{const k=await invocationKey(caller,name,args);if(typeof k!=='string'||!k)throw new PersonalToolError('technical_invocation_key_required',409);const id=hash([owner(a),name,k]);return{id,key:'personal:'+id};};
 const owned=async(a,id)=>{
  const r=await v8(a,'/v2/projects/read',{project_id:id}),p=r.project;
  if(!p||p.owner_id!==owner(a)||p.visibility!=='personal'||p.state!=='active')throw new PersonalToolError('own_personal_project_required',403);
  return p;
 };
 const ownProjects=async(a,query='')=>{
  const items=[];let cursor;
  do{const r=await v8(a,'/v2/projects/search',{query,limit:100,...(cursor?{cursor}:{})});
   for(const item of r.items??[]){if(item.owner_id&&item.owner_id!==owner(a))continue;
    try{items.push(await owned(a,item.project_id??item.id));}catch(e){if(e.status!==403)throw e;}}
   cursor=r.next_cursor;
  }while(cursor);return items;
 };
 const selectProject=async(a,args,{create=true}={})=>{
  if(args.project_id)return owned(a,args.project_id);
  const title=args.project_name??args.project??control.default_project_title??'我的个人资料',kind=args.kind??'project';
  if(typeof title!=='string'||!title||!['project','dialogue'].includes(kind))throw new PersonalToolError('invalid_personal_project_selector',400);
  const matches=(await ownProjects(a,title)).filter(p=>p.title===title&&((!create&&args.kind===undefined)||p.kind===kind));
  if(matches.length>1)throw new PersonalToolError('personal_project_ambiguous',409,{candidates:matches.map(p=>({project_id:p.id,title:p.title,kind:p.kind}))});
  if(matches.length===1)return matches[0];
  if(!create)throw new PersonalToolError('personal_project_not_found',404);
  // Existing API derives owner/organization from actual authenticated caller.
  // Same owner+title+kind key is the existing V8 creation idempotency, no new DB.
  const r=await v8(a,'/v2/projects',{title,kind,visibility:'personal',idempotency_key:'personal-space:'+hash([owner(a),title,kind])});
  return owned(a,r.project.id);
 };
 const path=args=>{if(typeof args.path!=='string'||!args.path||args.path.length>1024||args.path.startsWith('/')||args.path.split('/').includes('..')||/[\x00\r\n]/.test(args.path))throw new PersonalToolError('invalid_personal_path',400);return args.path;};
 const find=async(a,pid,logical)=>{const row=await currentPaths.find(a,pid,logical);return row?.material_id??null;};
 const shape=(pid,ref,extra={})=>{const file_id=currentPaths.aliasForMaterial(ref.material_id)??'m2p_'+pid+'_'+ref.material_id;return{file_id,address:addressFor?.(file_id)??'/f/'+file_id,ver:null,
  fixed_ref:{project_id:pid,...ref},source_version:{selection:'native_personal',project_id:pid,material_id:ref.material_id,version_id:ref.version_id},...extra};};
 const upload=async(caller,args)=>{
  if(!enabled()||args.space!=='personal')return{handled:false};
  const explicit=Boolean(args.project_id||args.project_name||args.project||args.native_personal===true);
  // Old personal file-ID/path data stays on the original credential channel.
  // Without explicit selection, keep an existing/unknown old path compatible.
  if(!explicit&&!currentPaths.isKnownOriginalPath(args.path)&&await hasOriginalCredential(caller)){
   const exists=await oldPersonalPathExists(caller,args.path).catch(()=>null);if(exists!==false)return{handled:false};
  }
  const a=await identity(caller),p=await selectProject(a,args),pid=p.id,logical=path(args),op=await key(caller,a,'mengchu_upload',args);
  if((typeof args.content_text==='string')===(typeof args.content_base64==='string'))throw new PersonalToolError('exactly_one_content_required',400);
  return state.exclusive(op.id,async()=>{
   let r=await state.load(op.id),fp=hash([pid,logical,args.content_text??null,args.content_base64??null,args.note??null]);
   if(r&&r.fingerprint!==fp)throw new PersonalToolError('idempotency_conflict',409);
   if(!r){const mid=await find(a,pid,logical),h=mid?await mem(a,'/v2/materials/head',{project_id:pid,material_id:mid}):null;
    r={fingerprint:fp,material_id:mid,base_version_id:h?.fixed_ref?.version_id??null,base_revision:h?.content_revision??0,state:'prepared'};await state.save(op.id,r);}
   if(typeof args.content_text==='string'){
    const result=await saveDocument(a,{project_id:pid,path:logical,text:args.content_text,register_work:false,idempotency_key:op.key,
     ...(r.material_id&&r.base_version_id?{material_id:r.material_id,base_version_id:r.base_version_id,base_revision:r.base_revision}:{}),
     source:{workflow:'mengchu_upload',native_personal:true},properties:{native_personal_workflow:true},...(args.note!==undefined?{note:args.note}:{})});
    const ref=result.fixed_ref??result.document?.fixed_refs?.[0];if(!ref)return{handled:true,result};
    r={...r,material_id:ref.material_id,state:'published',fixed_ref:ref};await state.save(op.id,r);
    return{handled:true,result:shape(pid,ref,{state:'published',description:result.description??{state:'not_requested'},index:result.index??{state:'not_requested'}})};
   }
   const bytes=Buffer.from(args.content_base64,'base64'),client=await makeClient(a,{project_id:pid,visibility:'personal'});let reply;
   if(r.checkpoint){const cp=r.checkpoint;if(!cp.meta)return{handled:true,result:{state:'metadata_response_unknown',idempotency_key:op.key,provider_send:false}};
    const m={...cp.meta,size:cp.request.size,sha256:cp.request.sha256},status=await client.resumeUpload(m,op.key);
    if(status.body?.publication_state==='published')reply=status;
    else if(status.body?.provider_receipt_present||['local_verified','publication_pending','publication_intent'].includes(status.body?.state))reply=await client.request('/api/files/upload-done',{file_id:m.file_id,upload_session_id:m.upload_session_id,ver:m.ver,size:m.size,sha256:m.sha256},op.key);
    else return{handled:true,result:{state:status.body?.state??'upload_unknown',idempotency_key:op.key,provider_send:false}};
   }else{if(r.state==='binary_intent')return{handled:true,result:{state:'metadata_response_unknown',idempotency_key:op.key,provider_send:false}};
    r={...r,state:'binary_intent'};await state.save(op.id,r);
    reply=await client.upload({project_id:pid,path:logical,file:()=>[bytes],logicalKey:op.key,
     metadata:{...(r.material_id?{file_id:'m2p_'+pid+'_'+r.material_id,expected_revision:r.base_revision,expected_version_id:r.base_version_id}:{}),category:'native_personal'},
     checkpoint:async cp=>{r={...r,checkpoint:cp};await state.save(op.id,r);}});}
   const b=reply?.body??reply,ref=b?.fixed_refs?.[0]??b?.receipt?.fixed_refs?.[0];if(!ref)return{handled:true,result:{state:b?.state??'publication_unknown',idempotency_key:op.key}};
   if(r.material_id&&ref.material_id!==r.material_id||ref.size!==bytes.length||ref.sha256!==createHash('sha256').update(bytes).digest('hex'))throw new PersonalToolError('published_identity_changed',502);
   r={...r,material_id:ref.material_id,state:'published',fixed_ref:ref};await state.save(op.id,r);return{handled:true,result:shape(pid,ref,{state:'published'})};
  });
 };
 const get=async(caller,args)=>{
  const locator=parsePersonalLocator(args.file_id);if(!enabled()||!locator)return{handled:false};const a=await identity(caller);
  if(args.ver!==undefined)throw new PersonalToolError('native_personal_requires_UUID_fixed_version',409);
  const h=await mem(a,'/v2/materials/head',locator),vid=args.version_id??h.fixed_ref?.version_id;if(!vid)throw new PersonalToolError('published_original_unavailable',409);
  const resolved=await mem(a,'/v2/references/resolve',{material_id:locator.material_id,version_id:vid,...(args.sha256?{sha256:args.sha256}:{})});
  if(resolved.fixed_ref?.project_id!==locator.project_id)throw new PersonalToolError('personal_locator_project_mismatch',403);
  const full=await readFull(a,{...resolved.fixed_ref});return{handled:true,result:{...full,...shape(locator.project_id,resolved.fixed_ref),state:'read'}};
 };
 const note=async(caller,args)=>{
  const loc=parsePersonalLocator(args.file_id);if(!enabled()||!loc)return{handled:false};if(typeof args.note!=='string'||[...args.note].length>500)throw new PersonalToolError('invalid_note',400);
  const a=await identity(caller),h=await mem(a,'/v2/materials/head',loc),op=await key(caller,a,'mengchu_note',args);
  return state.exclusive(op.id,async()=>{let r=await state.load(op.id);if(r&&r.body.text!==args.note)throw new PersonalToolError('idempotency_conflict',409);
   if(!r){const d=await mem(a,'/v2/materials/description-read',{...loc,version_id:h.fixed_ref.version_id,sha256:h.fixed_ref.sha256});r={body:{...loc,version_id:h.fixed_ref.version_id,sha256:h.fixed_ref.sha256,text:args.note,expected_revision:d.description?.revision??0,source_declaration:{workflow:'mengchu_note',native_personal:true},idempotency_key:op.key}};await state.save(op.id,r);}
   const description=await mem(a,'/v2/materials/description-save',r.body);let index={state:'not_requested'};
   if([1,2].includes(h.properties?.governance?.importance_level)&&indexDescription){try{index=await indexDescription(a,{project_id:loc.project_id,fixed_ref:h.fixed_ref});}catch{index={state:'enrichment_pending',description_saved:true};}}
   return{handled:true,result:{...shape(loc.project_id,{material_id:loc.material_id,version_id:r.body.version_id,sha256:r.body.sha256}),state:'registered',description,index}};});
 };
 const search=async(caller,args)=>{
  if(!enabled()||args.space!=='personal')return{handled:false};const a=await identity(caller),projects=args.project_id||args.project_name||args.project?[await selectProject(a,args,{create:false})]:await ownProjects(a),items=[];
  const limit=args.limit??50,q=(args.q??'').toLocaleLowerCase();if(!Number.isInteger(limit)||limit<1||limit>500)throw new PersonalToolError('invalid_limit',400);
  for(const p of projects){const s=await mem(a,'/v2/material-enumerations',{project_id:p.id});let cursor=0;
   do{const page=await mem(a,'/v2/material-enumerations/page',{project_id:p.id,snapshot_id:s.snapshot_id,cursor,limit:100});
    for(const x of page.items??[]){const h=await currentPaths.locate(a,x.material_id);if(h.project_id!==p.id||h.state!=='available'||!h.fixed_ref)continue;const logical=(h.placements??[]).find(z=>(!z.project_id||z.project_id===p.id)&&z.logical_path)?.logical_path;if(!logical)continue;
     const d=await mem(a,'/v2/materials/description-read',{project_id:p.id,material_id:x.material_id,version_id:h.fixed_ref.version_id,sha256:h.fixed_ref.sha256}),text=d.description?.text??'';
     if(args.scope==='knowledge'&&!text||q&&!logical.toLocaleLowerCase().includes(q)&&!text.toLocaleLowerCase().includes(q))continue;
     items.push({...shape(p.id,h.fixed_ref),path:logical,space:'personal',project:{id:p.id,title:p.title,kind:p.kind},note:text});if(items.length>=limit)break;
    }cursor=page.next_cursor;
   }while(items.length<limit&&cursor!==null&&cursor!==undefined);if(items.length>=limit)break;
  }
  let old=[];
  if(!args.project_id&&!args.project_name&&!args.project&&searchOriginalPersonal&&await hasOriginalCredential(caller)){
   old=(await searchOriginalPersonal(caller,args)).items??[]; // same old caller only.
  }
  const merged=items.concat(old.map(x=>({...x,source:'original_personal_credential_channel'}))).slice(0,limit);
  return{handled:true,result:{items:merged,returned_count:merged.length,source:old.length?'native_and_original_own_personal':'NativeDB_own_personal_projects',old_personal_data_migrated:false}};
 };
 return{upload,get,note,search,selectProject};
}
export const personalSelectorFields={project_id:{type:'string'},project_name:{type:'string'},project:{type:'string'},kind:{enum:['project','dialogue']},native_personal:{type:'boolean'},version_id:{type:'string'},sha256:{type:'string'}};

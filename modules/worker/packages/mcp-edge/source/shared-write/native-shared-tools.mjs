import{createHash}from'node:crypto';
const shared='d5027a95-f21b-483d-a9f1-06a91db45551';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export class NativeSharedError extends Error{constructor(code,status=503){super(code);this.code=code;this.status=status;this.handled=true;this.allow_old_fallback=false;}}
/** NativeDB placement/head is the truth. No separate file-ID/owner catalog on
 * Main or Jiaxin. Compatibility routing owns the registered old-path boundary. */
export function createNativeSharedTools({control,nextIdentity,memberMem,saveDocument,readFull,makeClient,state,invocationKey,addressFor,indexDescription,currentPaths}){
 const active=()=>control.mode==='next_shared_mcp'&&control.project_id===shared;
 const auth=async caller=>{const x=await nextIdentity(caller);if(!(x?.actor_id??x?.identity?.actor_id))throw new NativeSharedError('current_member_required',401);return x;};
 const actor=a=>a.actor_id??a.identity.actor_id;
 const mem=async(a,p,b)=>{const r=await memberMem(a,p,b);if(r?.error_code||r?.state==='failed')throw new NativeSharedError(r.error_code??'current_API_failed',r.status??403);return r;};
 const idFrom=x=>{if(typeof x==='string'&&/^https?:\/\//.test(x)){try{x=new URL(x).pathname.split('/').pop();}catch{return null;}}if(typeof x!=='string'||!x.startsWith('m2_')||!uuid.test(x.slice(3)))return null;return x.slice(3);};
 const head=(a,id)=>mem(a,'/v2/materials/head',{project_id:shared,material_id:id});
 const pathOf=args=>{
  let p=args.path;if(typeof p!=='string'||!p||p.startsWith('/')||p.split('/').includes('..')||/[\x00\r\n]/.test(p)||p.length>1024)throw new NativeSharedError('invalid_path',400);
  if(args.apply_month_prefix!==false&&!/^\d{4}-\d{2}\//.test(p)&&!p.startsWith('企业 AI 协作平台/')){const d=new Date();p=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'/'+p;}return p;
 };
 const findPath=async(a,p)=>{const row=await currentPaths.find(a,shared,p);return row?.material_id??null;};
 const key=async(caller,a,name,args)=>{
  const supplied=await invocationKey(caller,name,args);if(typeof supplied!=='string'||!supplied)throw new NativeSharedError('technical_invocation_key_required',409);
  return{key:'native-shared:'+digest([actor(a),name,supplied]),id:digest([actor(a),name,supplied])};
 };
 const shape=(ref,extra={})=>({file_id:currentPaths.aliasForMaterial(ref.material_id)??'m2_'+ref.material_id,address:addressFor?.(currentPaths.aliasForMaterial(ref.material_id)??'m2_'+ref.material_id)??'/f/'+(currentPaths.aliasForMaterial(ref.material_id)??'m2_'+ref.material_id),
  ver:null,fixed_ref:{project_id:shared,...ref},source_version:{selection:'native_shared',material_id:ref.material_id,version_id:ref.version_id},...extra});
 const upload=async(caller,args)=>{
  if(!active()||args.space!=='shared')return{handled:false};const p=pathOf(args);
  if((typeof args.content_text==='string')===(typeof args.content_base64==='string'))throw new NativeSharedError('exactly_one_content_required',400);
  if(args.note!==undefined&&(typeof args.note!=='string'||[...args.note].length>500))throw new NativeSharedError('invalid_note',400);
  const a=await auth(caller),operation=await key(caller,a,'mengchu_upload',args);
  return state.exclusive(operation.id,async()=>{
   let r=await state.load(operation.id);const fingerprint=digest([p,args.content_text??null,args.content_base64??null,args.note??null]);
   if(r&&r.fingerprint!==fingerprint)throw new NativeSharedError('idempotency_conflict',409);
   if(!r){
    const material_id=await findPath(a,p),h=material_id?await head(a,material_id):null;
    r={fingerprint,path:p,material_id,base_version_id:h?.fixed_ref?.version_id??null,base_revision:h?.content_revision??0,state:'prepared'};
    await state.save(operation.id,r);
   }
   if(typeof args.content_text==='string'){
    const saved=await saveDocument(a,{project_id:shared,path:p,text:args.content_text,register_work:false,idempotency_key:operation.key,
     ...(r.material_id&&r.base_version_id?{material_id:r.material_id,base_version_id:r.base_version_id,base_revision:r.base_revision}:{}),
     properties:{legacy_native_shared:true,legacy_logical_path:p},source:{workflow:'mengchu_upload',native_shared:true},...(args.note!==undefined?{note:args.note}:{})});
    const ref=saved.fixed_ref??saved.document?.fixed_refs?.[0];
    if(!ref)return{handled:true,result:{...saved,state:saved.state??'document_pending',idempotency_key:operation.key}};
    r={...r,material_id:ref.material_id,state:'published',fixed_ref:ref};await state.save(operation.id,r);
    return{handled:true,result:shape(ref,{state:'published',description:saved.description??{state:'not_requested'},index:saved.index??{state:'not_requested'},importance_preserved:true})};
   }
   const bytes=Buffer.from(args.content_base64,'base64'),client=await makeClient(a);
   let reply;
   if(r.checkpoint){
    const cp=r.checkpoint;if(!cp.meta)return{handled:true,result:{state:'metadata_response_unknown',idempotency_key:operation.key,provider_send:false}};
    const m={...cp.meta,size:cp.request.size,sha256:cp.request.sha256},status=await client.resumeUpload(m,operation.key);
    if(status.body?.publication_state==='published')reply=status;
    else if(status.body?.provider_receipt_present||['local_verified','publication_intent','publication_pending'].includes(status.body?.state))
     reply=await client.request('/api/files/upload-done',{file_id:m.file_id,upload_session_id:m.upload_session_id,ver:m.ver,size:m.size,sha256:m.sha256},operation.key);
    else return{handled:true,result:{state:status.body?.state??'upload_unknown',idempotency_key:operation.key,provider_send:false}};
   }else{
    if(r.state==='binary_intent')return{handled:true,result:{state:'metadata_response_unknown',idempotency_key:operation.key,provider_send:false}};
    r={...r,state:'binary_intent'};await state.save(operation.id,r);
    reply=await client.upload({project_id:shared,path:p,file:()=>[bytes],logicalKey:operation.key,
     metadata:{...(r.material_id?{file_id:'m2_'+r.material_id,expected_revision:r.base_revision,expected_version_id:r.base_version_id}:{}),category:'native_shared',
      note:JSON.stringify({workflow:'mengchu_upload',logical_path:p,original_note:args.note??null})},
     checkpoint:async cp=>{r={...r,checkpoint:cp};await state.save(operation.id,r);}});
   }
   const body=reply?.body??reply,ref=body?.fixed_refs?.[0]??body?.receipt?.fixed_refs?.[0];
   if(!ref)return{handled:true,result:{state:body?.state??'publication_unknown',idempotency_key:operation.key,automatic_new_upload:false}};
   if(r.material_id&&ref.material_id!==r.material_id||ref.size!==bytes.length||ref.sha256!==createHash('sha256').update(bytes).digest('hex'))throw new NativeSharedError('published_identity_changed',502);
   r={...r,material_id:ref.material_id,state:'published',fixed_ref:ref};await state.save(operation.id,r);
   let description={state:'not_requested'};
   if(args.note!==undefined&&args.idempotency_key===undefined){try{
    const existing=await mem(a,'/v2/materials/description-read',{project_id:shared,material_id:ref.material_id,version_id:ref.version_id,sha256:ref.sha256});
    description=await mem(a,'/v2/materials/description-save',{project_id:shared,material_id:ref.material_id,version_id:ref.version_id,sha256:ref.sha256,text:args.note,
     expected_revision:existing.description?.revision??0,source_declaration:{workflow:'mengchu_upload',binary_original:true},state:'active',idempotency_key:operation.key+':description'});
   }catch{description={state:'enrichment_pending',document_saved:true};}}
   return{handled:true,result:shape(ref,{state:'published',description,importance_preserved:true})};
  });
 };
 const get=async(caller,args)=>{
  const id=idFrom(args.file_id);if(!active()||!id)return{handled:false};
  // m2 has actual UUID versions, no invented legacy numeric history.
  if(args.ver!==undefined)throw new NativeSharedError('native_file_requires_fixed_UUID_version',409);
  const a=await auth(caller),h=await head(a,id);if(!h.fixed_ref)throw new NativeSharedError('published_original_unavailable',409);
  const result=await readFull(a,{project_id:shared,material_id:id,version_id:h.fixed_ref.version_id});
  return{handled:true,result:{...result,...shape(h.fixed_ref),state:'read'}};
 };
 const note=async(caller,args)=>{
  const id=idFrom(args.file_id);if(!active()||!id)return{handled:false};if(typeof args.note!=='string'||[...args.note].length>500)throw new NativeSharedError('invalid_note',400);
  const a=await auth(caller),h=await head(a,id),operation=await key(caller,a,'mengchu_note',args);
  return state.exclusive(operation.id,async()=>{
   let record=await state.load(operation.id);
   if(record?.body?.text!==undefined&&record.body.text!==args.note)throw new NativeSharedError('idempotency_conflict',409);
   if(!record){
    const desc=await mem(a,'/v2/materials/description-read',{project_id:shared,material_id:id,version_id:h.fixed_ref.version_id,sha256:h.fixed_ref.sha256});
    record={body:{project_id:shared,material_id:id,version_id:h.fixed_ref.version_id,sha256:h.fixed_ref.sha256,
     text:args.note,expected_revision:desc.description?.revision??0,state:'active',source_declaration:{workflow:'mengchu_note'},idempotency_key:operation.key}};
    await state.save(operation.id,record);
   }
   const saved=await mem(a,'/v2/materials/description-save',record.body);
   let index={state:'not_requested'};
   if([1,2].includes(h.properties?.governance?.importance_level)&&indexDescription){try{index=await indexDescription(a,{project_id:shared,fixed_ref:{material_id:id,version_id:record.body.version_id,sha256:record.body.sha256}});}catch{index={state:'enrichment_pending',description_saved:true};}}
   return{handled:true,result:{...shape({material_id:id,version_id:record.body.version_id,sha256:record.body.sha256}),state:'registered',description:saved,index}};
  });
 };
 const search=async(caller,args)=>{
  if(!active()||args.space!=='shared')return{handled:false};const a=await auth(caller),q=(args.q??'').toLocaleLowerCase(),limit=args.limit??50,items=[];
  if(!Number.isInteger(limit)||limit<1||limit>500)throw new NativeSharedError('invalid_limit',400);
  const snapshot=await mem(a,'/v2/material-enumerations',{project_id:shared});let cursor=0;
  do{
   const page=await mem(a,'/v2/material-enumerations/page',{project_id:shared,snapshot_id:snapshot.snapshot_id,cursor,limit:100});
   for(const x of page.items??[]){
    const placements=x.placements??[{logical_path:x.logical_path}],p=placements.find(z=>z.logical_path&&!z.logical_path.startsWith('旧共享资料/'))?.logical_path;if(!p)continue;
    const h=await head(a,x.material_id);if(!h.fixed_ref)continue;
    const d=await mem(a,'/v2/materials/description-read',{project_id:shared,material_id:x.material_id,version_id:h.fixed_ref.version_id,sha256:h.fixed_ref.sha256});
    const text=d.description?.text??d.text??'';if(args.scope==='knowledge'&&!text)continue;if(q&&!p.toLocaleLowerCase().includes(q)&&!text.toLocaleLowerCase().includes(q))continue;
    if(args.by&&args.by!==String(h.owner_id??''))continue;
    items.push({...shape(h.fixed_ref),path:p,space:'shared',note:text,size:h.fixed_ref.size,importance:h.properties?.governance?.important??null});if(items.length>=limit)break;
   }
   cursor=page.next_cursor;
  }while(items.length<limit&&cursor!==null&&cursor!==undefined);
  return{handled:true,result:{items,returned_count:items.length,scope:args.scope??'files',space:'shared',source:'nativeDB_authorized_placements_and_heads'}};
 };
 return{upload,get,note,search};
}

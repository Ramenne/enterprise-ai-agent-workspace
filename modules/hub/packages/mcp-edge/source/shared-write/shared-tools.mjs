import{createHash}from'node:crypto';
import{readFile}from'node:fs/promises';
const catalog=JSON.parse(await readFile(new URL('./catalog.json',import.meta.url),'utf8'));
const byId=new Map(catalog.files.map(x=>[x.file_id,x])),byPath=new Map(catalog.files.map(x=>[x.path,x]));
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export class SharedToolError extends Error{constructor(code,status=503){super(code);this.code=code;this.status=status;this.handled=true;this.allow_old_fallback=false;}}
/** Current actor only. No Root bearer/Parent/machine credential supplied here.
 * Control's mode is explicit MCP-front-end takeover, not old SQLite writer fence. */
export function createSharedTools({control,nextIdentity,memberMem,readFull,makeClient,state,invocationKey,searchUnmigrated,indexDescription,currentPaths}){
 const writerFenced=id=>control.fenced_file_ids?.includes(id)===true;
 const enabled=()=>control.mode==='next_shared_mcp'&&control.space==='shared'&&control.project_id===catalog.project_id&&control.source_system===catalog.source_system;
 const member=async caller=>{const x=await nextIdentity(caller);if(!x?.actor_id)throw new SharedToolError('current_member_required',401);return x;};
 const call=async(identity,path,body)=>{const r=await memberMem(identity,path,body);if(r?.error_code||r?.state==='failed')throw new SharedToolError(r.error_code??'current_API_failed',r.status??403);return r;};
 const resolveFile=async(identity,file)=>{
  const material_id=currentPaths.materialForId(file.file_id);if(!material_id)throw new SharedToolError('registered_material_required',409);
  const h=await currentPaths.locate(identity,material_id);if(h.state!=='available'||!h.fixed_ref)throw new SharedToolError('mapped_current_unavailable');
  return{fixed_ref:{...h.fixed_ref,project_id:h.project_id},original_address:'/f/'+file.file_id,latest_binding_id:null};
 };
 const head=async(identity,ref)=>currentPaths.locate(identity,ref.material_id);
 const opKey=async(caller,identity,tool,args)=>{
  const key=await invocationKey(caller,tool,args);
  if(typeof key!=='string'||!key||key.length>160)throw new SharedToolError('technical_invocation_key_required',409);
  return{key:'legacy-next:'+hash([identity.actor_id,tool,key]),id:hash([identity.actor_id,tool,key])};
 };
 const enrich=async(identity,ref,text,operation,r,save)=>{
  const out={metadata:{state:'pending'},description:{state:'pending'},index:{state:'not_requested'}};
  let current;
  try{current=await head(identity,ref);}catch{out.metadata={state:'enrichment_pending'};out.description={state:'enrichment_pending'};return out;}
  try{
   r.note_body??={project_id:ref.project_id,material_id:ref.material_id,expected_revision:current.metadata_revision,
    idempotency_key:operation.key+':note',properties:{legacy_mengchu_note:text,legacy_last_uploader:identity.legacy_username??identity.username??identity.actor_id}};
   await save();out.metadata=await call(identity,'/v2/materials/metadata',r.note_body);
  }catch(e){out.metadata={state:'enrichment_pending',error_code:e.code??'note_pending'};}
  try{
   if(!r.description_body){
    const d=await call(identity,'/v2/materials/description-read',{project_id:ref.project_id,material_id:ref.material_id,version_id:ref.version_id,sha256:ref.sha256});
    r.description_body={project_id:ref.project_id,material_id:ref.material_id,version_id:ref.version_id,sha256:ref.sha256,text,
     expected_revision:d.description?.revision??0,state:'active',source_declaration:{workflow:'mengchu_note',mapped_legacy_file:true},idempotency_key:operation.key+':description'};await save();
   }
   out.description=await call(identity,'/v2/materials/description-save',r.description_body);
  }catch(e){out.description={state:'enrichment_pending',error_code:e.code??'description_pending'};}
  // Only explicit current importance plus the same current fixed head is indexed.
  // Re-read importance at the service boundary; no automatic judgment/body vector.
  if(current.properties?.governance?.important===true&&current.fixed_ref?.version_id===ref.version_id&&out.description.state!=='enrichment_pending'){
   if(indexDescription){try{out.index=await indexDescription(identity,{project_id:ref.project_id,fixed_ref:{material_id:ref.material_id,version_id:ref.version_id,sha256:ref.sha256}});}catch(e){out.index={state:'enrichment_pending',error_code:e.code??'description_index_pending'};}}
   else out.index={state:'enrichment_pending',error_code:'description_index_unconfigured'};
  }
  return out;
 };
 const normalizePath=args=>{
  let path=args.path;if(typeof path!=='string'||!path||path.startsWith('/')||path.split('/').includes('..')||/[\x00\r\n]/.test(path))throw new SharedToolError('invalid_path',400);
  if(args.apply_month_prefix!==false&&!/^\d{4}-\d{2}\//.test(path)&&!path.startsWith('企业 AI 协作平台/')){
   const now=new Date(),prefix=now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0');path=prefix+'/'+path;
  }
  return path;
 };
 const upload=async(caller,args)=>{
  if(!enabled()||args.space!=='shared')return{handled:false};
  const path=normalizePath(args);const pathIdentity=await member(caller),selected=await currentPaths.find(pathIdentity,catalog.project_id,path,'旧共享资料/');const file=selected?.file_id?byId.get(selected.file_id):null;if(!file)return{handled:false};
  if((typeof args.content_text==='string')===(typeof args.content_base64==='string'))throw new SharedToolError('exactly_one_content_required',400);
  if(args.note!==undefined&&(typeof args.note!=='string'||[...args.note].length>500))throw new SharedToolError('invalid_note',400);
  const identity=await member(caller),bytes=typeof args.content_text==='string'?Buffer.from(args.content_text,'utf8'):Buffer.from(args.content_base64,'base64');
  const operation=await opKey(caller,identity,'mengchu_upload',args);
  return state.exclusive(operation.id,async()=>{
   let r=await state.load(operation.id);const fp=hash([path,createHash('sha256').update(bytes).digest('hex'),args.note??null]);
   if(r&&r.fingerprint!==fp)throw new SharedToolError('idempotency_conflict',409);
   const loc=await resolveFile(identity,file),h=await head(identity,loc.fixed_ref);
   if(r?.result){
    if(args.note!==undefined){const ref=r.result.fixed_ref;const enrichment=await enrich(identity,ref,args.note,operation,r,()=>state.save(operation.id,r));r.result={...r.result,enrichment,description:enrichment.description,index:enrichment.index};await state.save(operation.id,r).catch(()=>{});}
    return{handled:true,result:{...r.result,old_writer_fenced:writerFenced(file.file_id)}};
   }
   if(!Number.isSafeInteger(h.content_revision)||!h.fixed_ref?.version_id)throw new SharedToolError('actual_base_required');
   const client=await makeClient(identity,{file_id:file.file_id,project_id:catalog.project_id,latest_binding_id:loc.latest_binding_id,material_id:loc.fixed_ref.material_id});
   let reply;
   if(r?.checkpoint){
    const cp=r.checkpoint;if(!cp.meta)return{handled:true,result:{state:'metadata_response_unknown',file_id:file.file_id,operation_id:operation.id,provider_send:false}};
    const m={...cp.meta,size:cp.request.size,sha256:cp.request.sha256};
    const status=await client.resumeUpload(m,operation.key);
    if(status.body?.publication_state==='published')reply=status;
    else if(status.body?.provider_receipt_present||['local_verified','publication_pending','publication_intent'].includes(status.body?.state))
     reply=await client.request('/api/files/upload-done',{file_id:m.file_id,upload_session_id:m.upload_session_id,ver:m.ver,size:m.size,sha256:m.sha256},operation.key);
    else return{handled:true,result:{state:status.body?.state??'upload_unknown',file_id:file.file_id,operation_id:operation.id,provider_send:false}};
   }else{
    if(r?.state==='intent')return{handled:true,result:{state:'metadata_response_unknown',file_id:file.file_id,operation_id:operation.id,provider_send:false}};
    r={state:'intent',fingerprint:fp,base_version_id:h.fixed_ref.version_id,base_revision:h.content_revision};await state.save(operation.id,r);
    reply=await client.upload({project_id:catalog.project_id,path:selected.path,file:()=>[bytes],logicalKey:operation.key,
     metadata:{file_id:'m2_'+loc.fixed_ref.material_id,expected_revision:r.base_revision,expected_version_id:r.base_version_id,category:'legacy_daily_write',
      ...(args.note!==undefined?{note:args.note}:{} )},checkpoint:async cp=>{r={...r,checkpoint:cp};await state.save(operation.id,r);}});
   }
   const body=reply?.body??reply,rawRef=body?.fixed_refs?.[0]??body?.receipt?.fixed_refs?.[0],ref=rawRef?{...rawRef,project_id:catalog.project_id}:null;
   if(!ref)return{handled:true,result:{state:body?.state??'publication_unknown',file_id:file.file_id,operation_id:operation.id,automatic_new_upload:false}};
   if(ref.material_id!==loc.fixed_ref.material_id)throw new SharedToolError('stable_material_changed',502);
   if(ref.size!==bytes.length||ref.sha256!==createHash('sha256').update(bytes).digest('hex'))throw new SharedToolError('publication_content_changed',502);
   // Old writer remains live: new UUID is factual; never fake old numeric n+1.
   const result={state:'published',file_id:file.file_id,address:new URL(loc.original_address,'https://mengchu.example.invalid/').href,size:ref.size,sha256:ref.sha256,ver:null,
    source_version:{source_system:catalog.source_system,selection:'next_MCP_frontend',material_id:ref.material_id,version_id:ref.version_id},
    fixed_ref:{project_id:catalog.project_id,material_id:ref.material_id,version_id:ref.version_id,sha256:ref.sha256,size:ref.size},old_writer_fenced:writerFenced(file.file_id),operation_id:operation.id};
   r={...r,state:'published',result};await state.save(operation.id,r);
   if(args.note!==undefined){const enrichment=await enrich(identity,ref,args.note,operation,r,()=>state.save(operation.id,r));result.enrichment=enrichment;result.description=enrichment.description;result.index=enrichment.index;r.result=result;await state.save(operation.id,r).catch(()=>{});}
   return{handled:true,result};
  });
 };
 const note=async(caller,args)=>{
  if(!enabled()||!byId.has(args.file_id))return{handled:false};
  if(typeof args.note!=='string'||[...args.note].length>500)throw new SharedToolError('invalid_note',400);
  const identity=await member(caller),file=byId.get(args.file_id),loc=await resolveFile(identity,file),h=await head(identity,loc.fixed_ref);
  const operation=await opKey(caller,identity,'mengchu_note',args);
  return state.exclusive(operation.id,async()=>{
   let r=await state.load(operation.id);if(r?.body&&r.body.properties.legacy_mengchu_note!==args.note)throw new SharedToolError('idempotency_conflict',409);
   if(r?.description_body&&r.description_body.text!==args.note)throw new SharedToolError('idempotency_conflict',409);
   if(!r){r={state:'note_intent',fixed_ref:loc.fixed_ref};await state.save(operation.id,r);}
   if(r.body&&!r.note_body)r.note_body=r.body;
   const ref={...(r.fixed_ref??loc.fixed_ref),project_id:loc.fixed_ref.project_id};
   const enrichment=await enrich(identity,ref,args.note,operation,r,()=>state.save(operation.id,r));
   const result={state:enrichment.metadata.state==='enrichment_pending'||enrichment.description.state==='enrichment_pending'||enrichment.index.state==='enrichment_pending'?'enrichment_pending':'registered',
    file_id:file.file_id,note:args.note,address:new URL(loc.original_address,'https://mengchu.example.invalid/').href,
    fixed_ref:{...ref},source_version:{material_id:ref.material_id,version_id:ref.version_id},
    receipt:enrichment.metadata,description:enrichment.description,index:enrichment.index,enrichment};
   r.result=result;await state.save(operation.id,r).catch(()=>{});return{handled:true,result};
  });
 };
 const readLatest=async(caller,args)=>{
  if(!enabled()||!byId.has(args.file_id)||args.ver!==undefined)return{handled:false};
  const identity=await member(caller),loc=await resolveFile(identity,byId.get(args.file_id));
  const r=await readFull(identity,{project_id:loc.fixed_ref.project_id,material_id:loc.fixed_ref.material_id,version_id:loc.fixed_ref.version_id});
  const raw=r?.bytes??r?.body??r,stream=Buffer.isBuffer(raw)||raw instanceof Uint8Array?[raw]:raw;
  if(!stream?.[Symbol.asyncIterator]&&!stream?.[Symbol.iterator])throw new SharedToolError('current_body_stream_required');
  let size=0;const pieces=[],digest=createHash('sha256');for await(const b of stream){
   if(!(b instanceof Uint8Array))throw new SharedToolError('current_body_invalid',502);size+=b.length;
   if(size>loc.fixed_ref.size)throw new SharedToolError('current_body_integrity_mismatch',502);pieces.push(Buffer.from(b));digest.update(b);
  }
  if(size!==loc.fixed_ref.size||digest.digest('hex')!==loc.fixed_ref.sha256)throw new SharedToolError('current_body_integrity_mismatch',502);
  const bytes=Buffer.concat(pieces),text=bytes.toString('utf8'),textPath=/\.(?:md|txt|html?|json|csv|tsv|css|js|mjs|ts|ya?ml|xml|svg|sql|log)$/i.test(byId.get(args.file_id).path);
  const isText=textPath&&Buffer.from(text,'utf8').equals(bytes);
  return{handled:true,result:{file_id:args.file_id,address:new URL(loc.original_address,'https://mengchu.example.invalid/').href,size,content_type:r?.content_type??(isText?'text/plain; charset=utf-8':'application/octet-stream'),
   ...(isText?{text}:{bytes_base64:bytes.toString('base64')}),source_version:{source_system:catalog.source_system,selection:'latest_at_next_request',material_id:loc.fixed_ref.material_id,version_id:loc.fixed_ref.version_id},old_writer_fenced:writerFenced(args.file_id)}};
 };
 const search=async(caller,args)=>{
  if(!enabled()||args.space!=='shared')return{handled:false};
  const identity=await member(caller),limit=args.limit??50;if(!Number.isInteger(limit)||limit<1||limit>500)throw new SharedToolError('invalid_limit',400);
  const q=(args.q??'').toLocaleLowerCase(),items=[];
  // Filtering before limit; current member lookup/head per item, no Root inventory
  // responses. Search remains scoped file-ledger/registered-note, not body RAG.
  for(const entry of await currentPaths.rows(identity,catalog.project_id)){
   const file=byId.get(entry.file_id);if(!file)continue;
   try{
    const loc=await resolveFile(identity,file),h=await head(identity,loc.fixed_ref);if(h.project_id!==catalog.project_id)continue;const props=h.properties??{};
    const registered=props.legacy_mengchu_note??file.original_note??'';
    if(args.scope==='knowledge'&&!registered)continue;
    const by=props.legacy_last_uploader??file.original_by??null;if(args.by&&by!==args.by)continue;
    if(q&&!entry.path.toLocaleLowerCase().includes(q)&&!String(registered).toLocaleLowerCase().includes(q))continue;
    items.push({id:file.file_id,file_id:file.file_id,path:entry.path,space:'shared',note:registered,size:loc.fixed_ref.size,address:new URL(loc.original_address,'https://mengchu.example.invalid/').href,ver:null,owner:file.original_by,owner_semantics:'legacy_uploader;project_qualification_controls_access',
     source_version:{material_id:loc.fixed_ref.material_id,version_id:loc.fixed_ref.version_id},original_by:by});
    if(items.length>=limit)break;
   }catch(e){if(e.status===403||e.status===404)continue;throw e;}
  }
  // Old internal writers remain live. Preserve their non-catalog search results,
  // but never let a denied/new-sourced catalog ID reappear through old search.
  const old=searchUnmigrated?await searchUnmigrated(caller,args,{exclude_file_ids:[...byId.keys()]}):null;
  const merged=items.concat((old?.items??[]).filter(x=>!byId.has(x.file_id??x.id))).slice(0,limit);
  return{handled:true,result:{...(args.scope==='knowledge'?{knowledge:merged}:{files:merged}),count:merged.length,items:merged,returned_count:merged.length,scope:args.scope??'files',space:'shared',source_system:catalog.source_system,
   coverage:old?'current_next_catalog_and_current_old_unmigrated':'authorized_migrated_catalog87_only',old_index_consumers_migrated:false}};
 };
 const intercept=async(tool,caller,args)=>{
  if(tool==='mengchu_upload')return upload(caller,args);
  if(tool==='mengchu_note')return note(caller,args);
  if(tool==='mengchu_get')return readLatest(caller,args);
  if(tool==='mengchu_search')return search(caller,args);
  return{handled:false};
 };
 return{upload,note,readLatest,search,intercept};
}

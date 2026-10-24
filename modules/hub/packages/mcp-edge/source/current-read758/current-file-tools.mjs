import {readFile,stat} from 'node:fs/promises';
const aliasFile=new URL('./registered-aliases.json',import.meta.url);let rows=JSON.parse(await readFile(aliasFile,'utf8')),aliasStamp='';
async function refreshAliases(){const s=await stat(aliasFile),stamp=s.mtimeMs+':'+s.size;if(stamp!==aliasStamp){const next=JSON.parse(await readFile(aliasFile,'utf8'));if(!Array.isArray(next))throw Error('invalid_registered_alias_catalog');rows=next;aliasStamp=stamp;}}
const uuid='[a-f0-9-]{36}';
const denied=code=>{throw Object.assign(Error(code),{status:409,handled:true,allow_old_fallback:false});};
export function materialFromNativeId(value){
 const m=new RegExp('^m2_('+uuid+')$|^m2p_'+uuid+'_('+uuid+')$','i').exec(value);
 return m?.[1]??m?.[2]??null;
}
export function normalizeFile(value,version){
 let id=value,ver=version;
 if(typeof value==='string'&&value.startsWith('https://')){
  const u=new URL(value);if(['service.example.invalid','service.example.invalid','service.example.invalid'].includes(u.hostname)){
   const p=/^\/(?:f|files)\/([^/]+)(?:\/([1-9]\d*))?$/.exec(u.pathname);
   if(p){id=p[1];const uriVersion=p[2]??u.searchParams.get('ver')??u.searchParams.get('v');if(uriVersion!==null&&uriVersion!==undefined){if(ver!==undefined&&Number(uriVersion)!==ver)denied('conflicting_version_selection');ver=Number(uriVersion);}}
  }
 }
 return{file_id:id,ver};
}
/** The cache only decodes registered stable IDs. Actual target project and
 * read rights come from756 for EVERY request, including after scope moves. */
export function createCurrentFileTools({nextIdentity,memberMem,readFull,managedIds,state,invocationKey,indexDescription}){
 const managed=new Set(managedIds);const managedFile=id=>managed.has(id)||rows.some(x=>x.file_id===id&&x.writer_fenced===true);
 const rawCall=async(a,path,b)=>memberMem(a,path,b);
 async function locate(caller,args){
  await refreshAliases();const known=new Set(rows.map(x=>x.file_id));
  const {file_id:id,ver}=normalizeFile(args.file_id,args.ver),native=materialFromNativeId(id);
  if(!native&&!known.has(id))return{handled:false};
  if(!native&&ver===undefined&&!managedFile(id)&&!caller.token.startsWith('hub2_'))return{handled:false,prefer_live_legacy:true};
  let ref;
  if(native&&ver!==undefined)denied('native_history_requires_fixed_UUID_reference');
  if(!native){if(ver!==undefined&&(!Number.isSafeInteger(ver)||ver<1))denied('invalid_legacy_version');
   ref=rows.find(x=>x.file_id===id&&x.selection===(ver===undefined?'latest':'fixed')&&(ver===undefined||x.legacy_version===ver));if(!ref&&ver!==undefined)ref=rows.find(x=>x.file_id===id&&x.selection==='pending'&&x.legacy_version===ver);
   if(!ref){if(!managedFile(id))return{handled:false,prefer_live_legacy:true};denied('registered_fixed_version_unavailable');}
  }
  const a=await nextIdentity(caller);
  const location=await rawCall(a,'/v2/materials/locate',{material_id:native??ref.material_id,...(ver!==undefined&&ref.selection!=='pending'?{version_id:ref.version_id}:{})});
  if(!location.fixed_ref)denied('published_original_required');
  if(ver!==undefined&&ref.selection!=='pending'&&ref.sha256&&ref.sha256!==location.fixed_ref.sha256)denied('registered_fixed_reference_changed');
  return{handled:true,auth:a,file_id:id,location,legacy_ver:ver,history_pending:ref?.selection==='pending',history_descriptor:ref?.selection==='pending'?ref:undefined,snapshot_only:!native&&!managedFile(id)};
 }
 async function get(caller,args){
  const l=await locate(caller,args);if(!l.handled)return l;
  if(l.history_pending)return{handled:true,result:{state:'historical_metadata_unverified',file_id:l.file_id,material_id:l.location.material_id,requested_legacy_version:l.legacy_ver,source_locator:{region:l.history_descriptor.source_region,key:l.history_descriptor.source_key},original_sha256:l.history_descriptor.sha256,original_size:l.history_descriptor.size,provider_verification:'unverified',content_returned:false,coverage:'exact_legacy_ledger_metadata;no_bytes_delivered',next_step:'register_only_this_history_or_resume_low_priority_history_page;never_use_latest'}};
  const filename=l.location.placements?.[0]?.logical_path??rows.find(x=>x.file_id===l.file_id&&x.selection==='latest')?.logical_path??'';
  const textPath=/\.(?:md|txt|html?|json|csv|tsv|css|js|mjs|ts|ya?ml|xml|svg|sql|log)$/i.test(filename);
  const common={file_id:l.file_id,address:(materialFromNativeId(l.file_id)?'https://hufu.example.invalid/files/':'https://mengchu.example.invalid/f/')+l.file_id,size:l.location.fixed_ref.size,fixed_ref:l.location.fixed_ref,source_version:{material_id:l.location.material_id,version_id:l.location.fixed_ref.version_id,project_id:l.location.project_id},old_writer_fenced:managedFile(l.file_id)};
  if(l.location.fixed_ref.size>4*1024*1024||textPath&&l.location.fixed_ref.size>512*1024)return{handled:true,result:{...common,state:'metadata_only',content_returned:false,next_step:'use_mengchu_stage_fetch_or_fixed_download;no_truncated_body_returned'}};
  const full=await readFull(l.auth,{material_id:l.location.material_id,version_id:l.location.fixed_ref.version_id,project_id:l.location.project_id,encoding:'base64'});
  const bytes=Buffer.from(full.bytes_base64,'base64'),decoded=bytes.toString('utf8');
  const x={...full};delete x.bytes_base64;
  if(textPath&&bytes.length<=512*1024&&Buffer.from(decoded,'utf8').equals(bytes))x.text=decoded;else x.bytes_base64=full.bytes_base64;
  return{handled:true,result:{...x,file_id:l.file_id,address:(materialFromNativeId(l.file_id)?'https://hufu.example.invalid/files/':'https://mengchu.example.invalid/f/')+l.file_id,content_type:typeof x.text==='string'?'text/plain; charset=utf-8':'application/octet-stream',
   source_version:{material_id:l.location.material_id,version_id:l.location.fixed_ref.version_id,project_id:l.location.project_id,...(l.legacy_ver?{legacy_ver:l.legacy_ver}:{}),selection:l.snapshot_only?'observed_legacy_generated_index_snapshot':l.legacy_ver?'fixed':'latest_at_current_location'},old_writer_fenced:managedFile(l.file_id)}};
 }
 async function note(caller,args){
  const l=await locate(caller,{file_id:args.file_id});if(!l.handled)return l;
  if(l.snapshot_only)return{handled:false,prefer_live_legacy:true};
  if(typeof args.note!=='string'||[...args.note].length>500)denied('invalid_note');
  const key=await invocationKey(caller,'mengchu_note',args),id=key;
  return state.exclusive(id,async()=>{
   let r=await state.load(id);const fixed=l.location.fixed_ref;
   if(r&&r.text!==args.note)denied('idempotency_conflict');
   if(!r){const d=await rawCall(l.auth,'/v2/materials/description-read',{project_id:l.location.project_id,material_id:fixed.material_id,version_id:fixed.version_id,sha256:fixed.sha256});
    r={text:args.note,body:{project_id:l.location.project_id,material_id:fixed.material_id,version_id:fixed.version_id,sha256:fixed.sha256,text:args.note,expected_revision:d.description?.revision??0,source_declaration:{author:'current_Agent',purpose:'document_introduction'},idempotency_key:'current-file-note:'+key}};await state.save(id,r);}
   const d=await rawCall(l.auth,'/v2/materials/description-save',r.body);let index={state:'not_requested'};
   // Semantic enrichment never becomes a file-read/write gate.
   const h=await rawCall(l.auth,'/v2/materials/head',{project_id:l.location.project_id,material_id:fixed.material_id});
   let metadata={state:'not_requested'};
   if(!r.metadata_body){r.metadata_body={project_id:l.location.project_id,material_id:fixed.material_id,expected_revision:h.metadata_revision,properties:{legacy_mengchu_note:args.note},idempotency_key:'current-file-note-meta:'+key};await state.save(id,r);}
   try{metadata=await rawCall(l.auth,'/v2/materials/metadata',r.metadata_body);}catch{metadata={state:'enrichment_pending',description_saved:true};}
   if([1,2].includes(h.properties?.governance?.importance_level)&&h.fixed_ref?.version_id===r.body.version_id&&indexDescription)try{index=await indexDescription(l.auth,{project_id:l.location.project_id,fixed_ref:{material_id:fixed.material_id,version_id:r.body.version_id,sha256:r.body.sha256}});}catch{index={state:'enrichment_pending',description_saved:true};}
   const result={state:'registered',file_id:l.file_id,description:d,metadata,index,fixed_ref:{...fixed,version_id:r.body.version_id,sha256:r.body.sha256},old_writer_fenced:managedFile(l.file_id)};r.result=result;await state.save(id,r);return{handled:true,result};
  });
 }
 return{locate,get,note,knows:async id=>{await refreshAliases();return !!materialFromNativeId(id)||rows.some(x=>x.file_id===id)},isManaged:async id=>{await refreshAliases();return managedFile(id)},alias:async id=>{await refreshAliases();return rows.find(x=>x.file_id===id)}};
}

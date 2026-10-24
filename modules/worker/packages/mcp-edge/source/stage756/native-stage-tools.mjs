import {constants} from 'node:fs';
import {open,mkdir,lstat,realpath,rename} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {join,resolve} from 'node:path';
const MAX=64*1024*1024;
const hash=b=>createHash('sha256').update(b).digest('hex');
const fail=(code,status=409)=>{throw Object.assign(new Error(code),{code,status,handled:true,allow_old_fallback:false});};
/** Inject current-member routes; never a service/Root credential. A positive route
 * commits to native handling, including permission failures: no legacy fallback. */
export function createNativeStageTools({root,nextIdentity,locateFile,locateTarget,resolveFixed,readChunk,makeClient,state,invocationKey,prepareSource,commitSource}){
 const actor=a=>a.actor_id??a.identity?.actor_id;
 async function directory(p){await mkdir(p,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});const s=await lstat(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o777)!==0o700)fail('unsafe_stage_directory',503);}
 async function actorRoot(a){if(!actor(a))fail('current_member_required',401);const r=resolve(root);await directory(r);if(await realpath(r)!==r)fail('stage_root_symlink',503);const p=join(r,hash(Buffer.from(actor(a))));await directory(p);return p;}
 async function save(p,x){const temp=p+'.'+randomUUID();const f=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await f.writeFile(JSON.stringify(x));await f.sync();}finally{await f.close();}await rename(temp,p);const d=await open(resolve(p,'..'),constants.O_RDONLY);try{await d.sync();}finally{await d.close();}}
 async function secure(p){const f=await open(p,constants.O_RDONLY|constants.O_NOFOLLOW);try{const s=await f.stat();if(!s.isFile()||s.uid!==process.getuid()||(s.mode&0o777)!==0o600||s.size>MAX)fail('unsafe_stage_file',403);return {f,s};}catch(e){await f.close();throw e;}}
 const auth=async caller=>{const a=await nextIdentity(caller);if(!actor(a))fail('current_member_required',401);return a;};
 const fetch=async(caller,args)=>{
  const route=await locateFile(caller,args.file_id);if(!route?.handled)return {handled:false};
  const a=await auth(caller),dir=await actorRoot(a),fixed=await resolveFixed(a,route.fixed_ref??route);
  if(!fixed?.version_id||!fixed?.project_id||!fixed?.material_id||!Number.isSafeInteger(fixed.size)||fixed.size>MAX||fixed.size<0)fail('fixed_original_over_stage_limit',413);
  const id=randomUUID(),path=join(dir,id+'.body'),part=path+'.partial',f=await open(part,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  let size=0,offset=0;const digest=createHash('sha256');
  try{do{const r=await readChunk(a,{project_id:fixed.project_id,material_id:fixed.material_id,version_id:fixed.version_id,offset,limit:65536,encoding:'base64'});
    const b=Buffer.from(r.bytes_base64??'','base64');if(b.length>65536||hash(b)!==r.chunk_sha256||r.fixed_ref?.version_id!==fixed.version_id||r.fixed_ref?.sha256!==fixed.sha256)fail('fixed_chunk_integrity_failed',502);
    size+=b.length;if(size>MAX||size>fixed.size)fail('stage_limit_exceeded',413);digest.update(b);await f.writeFile(b);
    const n=r.next_offset;if(n!==null&&n!==undefined&&(!Number.isSafeInteger(n)||n!==offset+b.length||n<=offset))fail('invalid_chunk_cursor',502);offset=n;
   }while(offset!==null&&offset!==undefined);
   if(size!==fixed.size||digest.digest('hex')!==fixed.sha256)fail('whole_fixed_integrity_failed',502);await f.sync();
  }finally{await f.close();}
  await rename(part,path);await save(path+'.json',{actor_id:actor(a),source_fixed_ref:fixed,size,sha256:fixed.sha256,file_id:args.file_id,created_at:new Date().toISOString(),state:'complete'});
  return {handled:true,result:{state:'staged',src_path:path,size,sha256:fixed.sha256,source_fixed_ref:fixed,file_id:args.file_id,content_returned:false}};
 };
 const upload=async(caller,args)=>{
  // Recognize owned staging first. Its files can never be handed to an old
  // arbitrary-path uploader even when the selected destination is unknown.
  const nativePath=typeof args.src_path==='string'&&resolve(args.src_path).startsWith(resolve(root)+'/');
  const target=await locateTarget(caller,args);if(!target?.handled){if(nativePath)fail('native_stage_destination_unregistered',409);return{handled:false};}
  if(args.note!==undefined&&(typeof args.note!=='string'||[...args.note].length>500))fail('invalid_note',400);
  const a=await auth(caller),dir=await actorRoot(a);if(typeof args.src_path!=='string'||!/^[-a-f0-9]{36}\.body$/.test(args.src_path.slice(dir.length+1))||resolve(args.src_path)!==args.src_path||!args.src_path.startsWith(dir+'/'))fail('stage_actor_path_denied',403);
  const {f,s}=await secure(args.src_path);let meta;
  try{const mf=await secure(args.src_path+'.json');try{meta=JSON.parse(await mf.f.readFile('utf8'));}finally{await mf.f.close();}
   if(meta.actor_id!==actor(a)||meta.state!=='complete'||s.size!==meta.size)fail('stage_actor_or_size_mismatch',403);
   const key=await invocationKey(caller,'mengchu_stage_upload',args);if(!key)fail('invocation_key_required');const id=hash(Buffer.from(JSON.stringify([actor(a),key])));
   return await state.exclusive(id,async()=>{
    let r=await state.load(id);const fingerprint=hash(Buffer.from(JSON.stringify([args.src_path,args.space,args.path,args.note??null,target.project_id,meta.sha256])));
    if(r&&r.fingerprint!==fingerprint)fail('idempotency_conflict');if(!r){r={fingerprint,state:'prepared',target,source_fixed_ref:meta.source_fixed_ref};await state.save(id,r);}
    if(r.result)return{handled:true,result:r.result};
    if(!r.source_run){if(!prepareSource)fail('processing_source_integration_required',503);r.source_run=await prepareSource(a,{target:r.target,source_fixed_ref:r.source_fixed_ref,logical_key:key},async update=>{r.source_prepare=update;await state.save(id,r);});await state.save(id,r);}
    const client=await makeClient(a);let reply;
    if(r.checkpoint){const cp=r.checkpoint;if(!cp.meta)return{handled:true,result:{state:'metadata_response_unknown',automatic_new_upload:false,source_fixed_ref:r.source_fixed_ref}};
     const m={...cp.meta,size:cp.request.size,sha256:cp.request.sha256},q=await client.resumeUpload(m,key);
     if(q.body?.publication_state==='published')reply=q;
     else if(q.body?.provider_receipt_present||['local_verified','publication_intent','publication_pending'].includes(q.body?.state))reply=await client.request('/api/files/upload-done',{file_id:m.file_id,upload_session_id:m.upload_session_id,ver:m.ver,size:m.size,sha256:m.sha256},key);
     else return{handled:true,result:{state:q.body?.state??'upload_unknown',automatic_new_upload:false,source_fixed_ref:r.source_fixed_ref}};
    }else if(r.state==='sending')return{handled:true,result:{state:'metadata_response_unknown',automatic_new_upload:false,source_fixed_ref:r.source_fixed_ref}};
    else{r.state='sending';await state.save(id,r);
     // One trusted open fd, repeated positional reads: path replacement cannot
     // change the bytes between the V4 hash and body passes. No 64MiB buffer.
     const file=async function*(){let pos=0;while(pos<s.size){const b=Buffer.alloc(Math.min(65536,s.size-pos));const x=await f.read(b,0,b.length,pos);if(!x.bytesRead)fail('stage_file_changed');pos+=x.bytesRead;yield b.subarray(0,x.bytesRead);}};
     reply=await client.upload({project_id:target.project_id,path:target.path,file,logicalKey:key,metadata:{...(target.metadata??{}),origin_kind:'agent_processed',producer:'MCP_stage_copy',properties:{run_id:r.source_run.run_id,workflow:'MCP_stage_copy'},note:JSON.stringify({workflow:'mengchu_stage_upload',original_note:args.note??null,source_fixed_ref:r.source_fixed_ref})},checkpoint:async cp=>{if(cp.request?.sha256&&cp.request.sha256!==meta.sha256)fail('stage_file_changed');r.checkpoint=cp;await state.save(id,r);}});
    }
    const b=reply?.body??reply,ref=b?.fixed_refs?.[0]??b?.receipt?.fixed_refs?.[0];if(!ref)return{handled:true,result:{state:b?.state??'publication_unknown',source_fixed_ref:r.source_fixed_ref,automatic_new_upload:false}};
    if(ref.size!==meta.size||ref.sha256!==meta.sha256||target.material_id&&ref.material_id!==target.material_id)fail('publication_identity_changed',502);
    // agent_processed output stays pending until the original run finishes.
    r.fixed_ref=ref;r.state='output_published';await state.save(id,r);let source;
    try{if(!commitSource)fail('processing_finish_integration_required',503);source=await commitSource(a,r.source_run,ref,key);if(source.state!=='succeeded'&&source.technical_state!=='succeeded')return{handled:true,result:{state:'source_finish_pending',file_published:true,source_visibility:'processing_pending',fixed_ref:ref,source_fixed_ref:r.source_fixed_ref,run_id:r.source_run.run_id,automatic_new_upload:false}};}catch(e){return{handled:true,result:{state:'source_finish_pending',file_published:true,source_visibility:'processing_pending',fixed_ref:ref,source_fixed_ref:r.source_fixed_ref,run_id:r.source_run.run_id,error_code:e.code??'processing_finish_failed',automatic_new_upload:false}};}
    const publicId=target.public_file_id??(target.space==='personal'?`m2p_${target.project_id}_${ref.material_id}`:'m2_'+ref.material_id);
    r.result={state:'published',file_id:publicId,address:target.address??(publicId.startsWith('m2_')||publicId.startsWith('m2p_')?'https://hufu.example.invalid/files/':'https://mengchu.example.invalid/f/')+publicId,ver:null,fixed_ref:ref,size:ref.size,sha256:ref.sha256,source_fixed_ref:r.source_fixed_ref,source,description:{state:'not_requested'}};await state.save(id,r);return{handled:true,result:r.result};
   });
  }finally{await f.close();}
 };
 return {fetch,upload};
}

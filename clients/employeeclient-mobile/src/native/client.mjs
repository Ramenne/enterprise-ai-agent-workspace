import {uploadResponse} from './upload-progress.mjs';
import {sha256 as incrementalSha256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';
// Native browser member session. Never manufacture a qn1 token from a cookie.
export class NativeError extends Error {
  constructor(code, status=0,hint='') { super(hint||code); this.code=code; this.status=status; this.hint=hint; }
}
export function unwrap(result) {
  if (result?.status >= 400) throw new NativeError(result.body?.error_code || result.body?.error || 'upstream_rejected', result.status);
  const value = result?.body ?? result;
  if (!value || value.state === 'failed' || value.error_code || value.error)
    throw new NativeError(value?.error_code || value?.error || 'invalid_response');
  return value;
}
export class NativeClient {
  /** @param {{base?:string,fetcher?:typeof fetch,onUnauthorized?:()=>void,signal?:AbortSignal,loginStorage?:{restore:()=>Promise<void>,save:()=>Promise<void>,clear:()=>Promise<void>,recover?:()=>Promise<void>},requirePersistent?:boolean}} options */
  constructor({base='',fetcher,onUnauthorized=()=>{},signal,loginStorage,requirePersistent=false}={}) {
    this.loginStorage=loginStorage;this.requirePersistent=requirePersistent;this.sessionFlight=null;
    this.signal=signal; this.base=base.replace(/\/$/,''); this.fetcher=fetcher||globalThis.fetch.bind(globalThis);this.uploadFetcher=fetcher||globalThis.fetch; this.onUnauthorized=onUnauthorized;
    this.freshUploads=new WeakSet();this.epoch=0; this.partition=null; this.controllers=new Set();
  }
  reset() { this.epoch++; this.partition=null; for(const c of this.controllers)c.abort();this.controllers.clear(); }
  async request(path, body, key, signal=this.signal,timeoutMs=60000) {
    signal?.throwIfAborted();
    const epoch=this.epoch;
    const controller=new AbortController();this.controllers.add(controller);
    const abort=()=>controller.abort(signal?.reason);
    if(signal?.aborted) abort(); else signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>controller.abort(new DOMException('连接等待超时','TimeoutError')),timeoutMs);
    try {
      const response=await this.fetcher(this.base+'/native/'+path,{
        method:body===undefined?'GET':'POST',credentials:'include',cache:'no-store',signal:controller.signal,
        headers:body===undefined?{}:{'content-type':'application/json',...(key?{'idempotency-key':key}:{})},
        ...(body===undefined?{}:{body:JSON.stringify(body)}),
      });
      // A transport may still deliver a response after cancellation. Stop it
      // before consuming authority or publishing a success to the workflow.
      if(epoch!==this.epoch) throw new NativeError('session_changed',401);
      controller.signal.throwIfAborted();
      const value=await response.json();
      if(epoch!==this.epoch) throw new NativeError('session_changed',401);
      controller.signal.throwIfAborted();
      if(!response.ok) {
        if(response.status===401&&path!=='session') {const active=!!this.partition;this.reset();if(active)this.onUnauthorized();}
        throw new NativeError(value.error_code||value.error||value.message||'upstream_rejected',response.status);
      }
      return unwrap(value);
    } catch(error) {
      if(epoch!==this.epoch && !(error instanceof NativeError)) throw new NativeError('session_changed',401);
      if(!(error instanceof NativeError))controller.signal.throwIfAborted();
      throw error;
    } finally {this.controllers.delete(controller);clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  sendCode(email) {return this.request('send-code',{email,type:'sign-in'});}
  async signIn(email,otp) {
    this.reset();
    await this.request('sign-in',{email,otp});
    await this.loginStorage?.clear();
    return this.session(); // Successful OTP response alone is not a project session.
  }
  async session() {
    const epoch=this.epoch;if(this.sessionFlight?.epoch===epoch)return this.sessionFlight.work;
    const work=this.sessionOnce();this.sessionFlight={epoch,work};
    try{return await work;}finally{if(this.sessionFlight?.work===work)this.sessionFlight=null;}
  }
  async sessionOnce() {
    const epoch=this.epoch;
    if(this.loginStorage)await this.loginStorage.restore();
    if(epoch!==this.epoch)throw new NativeError('session_changed',401);
    let value;
    try{value=await this.request('session',undefined,undefined,this.signal,30000);}
    catch(error){
      if(!(error instanceof NativeError)||error.status!==401||epoch!==this.epoch)throw error;
      // Restore the native sealed credential before confirming an auth loss.
      await this.loginStorage?.recover?.();
      if(epoch!==this.epoch)throw new NativeError('session_changed',401);
      value=await this.request('session',undefined,undefined,this.signal,30000);
    }
    if(value.persistent_login_available&&!value.persistent_login){
      let intent;try{intent=localStorage.getItem('qn.member-login.intent');if(!intent){intent='qn-device-'+crypto.randomUUID();localStorage.setItem('qn.member-login.intent',intent);}}catch{intent='qn-device-'+crypto.randomUUID();}
      const issued=await this.request('persist-session',{},intent,this.signal,45000);
      // Set-Cookie delivery is not proof that the browser accepted the credential.
      value=await this.request('session',undefined,undefined,this.signal,30000);
      if(!value.persistent_login||!issued.identity?.actor_id||value.identity?.actor_id!==issued.identity.actor_id)throw new NativeError('persistent_login_not_retained',503);
      try{localStorage.removeItem('qn.member-login.intent');}catch{}
    }
    if(this.requirePersistent&&!value.persistent_login)throw new NativeError('persistent_login_unavailable',503);
    if(!value.identity?.actor_id) throw new NativeError('identity_missing',401);
    if(epoch!==this.epoch)throw new NativeError('session_changed',401);
    if(value.persistent_login)await this.loginStorage?.save();
    if(epoch!==this.epoch)throw new NativeError('session_changed',401);
    const partition=JSON.stringify(value.cache_partition??{actor_id:value.identity.actor_id});
    if(this.partition && this.partition!==partition) this.epoch++;
    this.partition=partition;
    return value;
  }
  async signOut(){await this.request('sign-out',{});await this.loginStorage?.clear();this.reset();try{localStorage.removeItem('qn.member-login.intent');}catch{}}
  rpc(name,args={},key,signal) {return this.request('rpc',{name,arguments:args},key,signal);}
  async projects(query='') {
    let cursor,items=[];const seen=new Set();
    do {
      const page=await this.rpc('v8.project.search',{query,limit:100,...(cursor?{cursor}:{})});
      items.push(...(page.items||[]));
      if(page.next_cursor && seen.has(page.next_cursor)) throw new NativeError('pagination_stalled');
      cursor=page.next_cursor;
      if(cursor) seen.add(cursor);
    } while(cursor);
    return items;
  }
  files(project_id,query='') {return this.rpc('mem.search',{project_id,query,limit:100});}
  head(project_id,material_id) {return this.rpc('mem.material.head',{project_id,material_id});}
  paths(project_id,paths) {return this.rpc('mem.material.by_path',{project_id,paths});}
  works(project_id,cursor,query='') {return this.rpc('v8.work.search',{project_id,limit:100,...(query?{query}:{}),...(cursor?{cursor}:{})});}
  work(project_id,work_item_id) {return this.rpc('v8.work.read',{project_id,work_item_id});}
  async prepareUpload(project_id,file,key,onProgress,properties) {
    const epoch=this.epoch;this.signal?.throwIfAborted();
    if(!Number.isSafeInteger(file.size)||file.size<0||file.size>100*1024**3) throw new NativeError('file_size_limit_100GiB');
    const hash=await hashFile(file,()=>{this.signal?.throwIfAborted();if(epoch!==this.epoch)throw new NativeError('session_changed',401);},loaded=>onProgress?.({phase:'hash',loaded,total:file.size}));
    if(epoch!==this.epoch) throw new NativeError('session_changed',401);
    // A filename is presentation, not object identity. Keep one stable path per
    // original upload key; two different files with the same name must coexist.
    const logical_path=await uploadLogicalPath(key,file.name);
    this.signal?.throwIfAborted();if(epoch!==this.epoch)throw new NativeError('session_changed',401);
    const result=await this.rpc('mem.upload.begin',{project_id,expected_revision:0,sha256:hash,size:file.size,logical_path,origin_kind:'member_submission',producer:'employeeclient-native-candidate',...(properties?{properties}:{}),idempotency_key:key},key);
    if(!result.operation_id) throw new NativeError('upload_operation_missing');
    // Keep the stable original operation, never the signed ticket, for resume.
    const operation={project_id,operation_id:result.operation_id,sha256:hash,size:file.size,key,name:file.name,...(properties?{properties}: {})};this.freshUploads.add(operation);return operation;
  }
  async finishUpload(operation,file,onProgress) {
    const epoch=this.epoch,args={project_id:operation.project_id,operation_id:operation.operation_id};
    if(file.size!==operation.size||await hashFile(file,()=>{this.signal?.throwIfAborted();if(epoch!==this.epoch)throw new NativeError('session_changed',401);},loaded=>onProgress?.({phase:'hash',loaded,total:file.size}))!==operation.sha256) throw new NativeError('resume_file_mismatch');
    const current=()=>{this.signal?.throwIfAborted();if(epoch!==this.epoch)throw new NativeError('session_changed',401);};
    current();
    // The registered public ingress accepts at most 32 MiB per request. Stay
    // below it instead of promising a 64 MiB single PUT through that gateway.
    if(operation.size>16*1024*1024)return this.finishMultipart(operation,file,current,onProgress);
    let status;const fresh=this.freshUploads.delete(operation);
    try {if(!fresh)status=await this.rpc('mem.upload.put_status',args);}
    catch(error) {
      // A fresh begin has no transfer mode yet. The first PUT ticket selects it.
      // Only this explicit no-mode response permits proceeding; an uncertain
      // provider/network result never starts a different upload operation.
      if(!(error instanceof NativeError)||error.code!=='upload_mode_conflict') throw error;
    }
    current();
    if(!['staging_complete','completed'].includes(status?.state)) {
      // The relay obtains and validates this same ticket using current member
      // authority. Do not request a duplicate ticket in the browser.
      current();
      const source=file instanceof Blob?file:file.readPart?await file.readPart(0,file.size):file.slice(0,file.size);
      await this.putContent(operation,source,undefined,loaded=>onProgress?.({phase:'upload',loaded,total:file.size}));
      if(epoch!==this.epoch) throw new NativeError('session_changed',401);
    }
    onProgress?.({phase:'verify',loaded:file.size,total:file.size});
    await this.rpc('mem.upload.put_complete',args);
    current();
    const published=await this.rpc('mem.upload.publish',args);
    if(published.state!=='published'||!published.fixed_refs?.length) throw new NativeError('publication_not_confirmed');
    const fixed=published.fixed_refs[0];
    if(fixed.sha256!==operation.sha256||fixed.size!==operation.size) throw new NativeError('publication_integrity_mismatch');
    return published;
  }
  fileUrl(project_id,fixed,name='文件') {
    const q=new URLSearchParams({project_id,material_id:fixed.material_id,version_id:fixed.version_id,name});
    return this.base+'/native/file?'+q.toString();
  }
  async putContent(operation,source,partNumber,progress) {
    this.signal?.throwIfAborted();
    const epoch=this.epoch,q=new URLSearchParams({project_id:operation.project_id,operation_id:operation.operation_id,size:String(source.size)});
    if(partNumber!==undefined)q.set('part_number',String(partNumber));
    let response;
    try{response=await uploadResponse(this.base+'/native/upload?'+q,source,this.signal,progress,this.uploadFetcher);}
    catch(error){if(error instanceof TypeError)throw new NativeError('staging_put_connection_failed',0);throw error;}
    this.signal?.throwIfAborted();if(epoch!==this.epoch)throw new NativeError('session_changed',401);
    const value=await response.json();
    this.signal?.throwIfAborted();if(epoch!==this.epoch)throw new NativeError('session_changed',401);
    if(!response.ok){if(response.status===401)this.onUnauthorized();throw new NativeError(value.error_code||'staging_put_failed',response.status);}
    if(value.state!=='staged'||value.operation_id!==operation.operation_id||value.size!==source.size)throw new NativeError('staging_response_invalid',502);
  }
  async finishMultipart(operation,file,current,onProgress) {
    const args={project_id:operation.project_id,operation_id:operation.operation_id};
    const size=16*1024*1024;
    await this.rpc('mem.upload.multipart.begin',{...args,part_size:size});current();
    const resume=await this.rpc('mem.upload.multipart.resume',args);current();
    if(resume.state==='aborted')throw new NativeError('upload_aborted');
    if(resume.state!=='completed'&&resume.state!=='provider_completed_sql_pending'){
      const partSize=resume.part_size||size;
      if(!Number.isSafeInteger(partSize)||partSize<5*1024*1024)throw new NativeError('multipart_size_invalid');
      const parts=new Map((resume.parts||[]).map(p=>[p.part_number??p.number,p]));
      for(let start=0,number=1;start<file.size;start+=partSize,number++){
        const end=Math.min(file.size,start+partSize),length=end-start;
        if(parts.get(number)?.size===length){onProgress?.({phase:'upload',loaded:end,total:file.size});continue;}
        // The relay obtains the current caller's validated part ticket.
        // Requesting it here as well adds a redundant round trip per part.
        current();
        const part=file.readPart?await file.readPart(start,end):file.slice(start,end);
        if(part.size!==length)throw new NativeError('upload_source_incomplete');current();
        await this.putContent(operation,part,number,loaded=>onProgress?.({phase:'upload',loaded:start+loaded,total:file.size}));current();
        onProgress?.({phase:'upload',loaded:end,total:file.size});
      }
      await this.rpc('mem.upload.multipart.complete',args);current();
    }else if(resume.state==='provider_completed_sql_pending'){
      await this.rpc('mem.upload.multipart.complete',args);current();
    }
    onProgress?.({phase:'verify',loaded:file.size,total:file.size});
    const published=await this.rpc('mem.upload.publish',args);current();
    const fixed=published.fixed_refs?.[0];
    if(published.state!=='published'||fixed?.sha256!==operation.sha256||fixed?.size!==operation.size)throw new NativeError('publication_not_confirmed');
    return published;
  }
  async readFile(project_id,fixed,signal) {
    fixed={...fixed};signal??=this.signal;const epoch=this.epoch;
    const check=()=>{signal?.throwIfAborted();if(epoch!==this.epoch)throw new NativeError('session_changed',401);};check();
    // This browser preview is bounded; the core storage capacity is not changed.
    if(!Number.isSafeInteger(fixed.size)||fixed.size<0||fixed.size>64*1024*1024) throw new NativeError('browser_download_limit_64MiB');
    const bytes=new Uint8Array(fixed.size);let offset=0;
    do {
      check();
      const page=await this.rpc('mem.version.read',{project_id,material_id:fixed.material_id,version_id:fixed.version_id,offset,limit:131072,encoding:'base64'},undefined,signal);
      check();const ref=page.fixed_ref;
      if(epoch!==this.epoch||ref?.material_id!==fixed.material_id||ref?.version_id!==fixed.version_id||ref?.sha256!==fixed.sha256||ref?.size!==fixed.size)
        throw new NativeError('fixed_reference_changed');
      if(typeof page.bytes_base64!=='string'||page.bytes_base64.length>4*Math.ceil(Math.min(131072,bytes.length-offset)/3))throw new NativeError('invalid_read_range');
      const chunk=Uint8Array.from(atob(page.bytes_base64),c=>c.charCodeAt(0));
      if(page.range?.start!==offset||page.range?.end_exclusive!==offset+chunk.length||offset+chunk.length>bytes.length)
        throw new NativeError('invalid_read_range');
      const chunkHash=await sha256(chunk);check();
      if(chunkHash!==page.chunk_sha256) throw new NativeError('chunk_integrity_mismatch');
      bytes.set(chunk,offset);offset+=chunk.length;
      if(page.next_offset!==null && page.next_offset!==undefined && (page.next_offset!==offset||chunk.length===0)) throw new NativeError('invalid_read_cursor');
      if(offset<bytes.length && (page.next_offset===null||page.next_offset===undefined)) throw new NativeError('incomplete_original');
      check();if(page.read_receipt?.id) await this.rpc('mem.read.acknowledge',{project_id,read_receipt_id:page.read_receipt.id,state:'acknowledged'},undefined,signal);
    } while(offset<bytes.length);
    check();const digest=await sha256(bytes);check();
    if(digest!==fixed.sha256) throw new NativeError('whole_integrity_mismatch');
    return new Blob([bytes]);
  }
}
export async function uploadLogicalPath(key,name) {
 return '员工客户端文件/'+await sha256(new TextEncoder().encode(String(key)))+'/'+encodeURIComponent(name);
}
export async function sha256(bytes) {
  const digest=await globalThis.crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
}

export async function hashFile(file,active=()=>{},progress=()=>{}) {
  const hash=incrementalSha256.create();
  for(let start=0;start<file.size;start+=4*1024*1024){
    active();const end=Math.min(file.size,start+4*1024*1024);
    const part=file.readPart?await file.readPart(start,end):file.slice(start,end);
    if(part.size!==end-start)throw new NativeError('upload_source_incomplete');
    hash.update(new Uint8Array(await part.arrayBuffer()));active();progress(end);await new Promise(resolve=>setTimeout(resolve,0));
  }
  return bytesToHex(hash.digest());
}

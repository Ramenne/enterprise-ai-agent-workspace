import {createHash} from 'node:crypto';
import {PROJECT,assertBusinessWrite} from './native-authority.mjs';
import {isGroupFile} from '../../shared/chat-media-purpose.mjs';
import {encryptedSource} from '../../shared/private-media.mjs';
const LIMIT=2*1024*1024;
const fail=(code,status=400)=>{throw Object.assign(Error(code),{code,status});};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

export async function readMediaFrame(req,signal){
 let prefix=Buffer.alloc(0),headerSize,meta,length=0,received=0;const parts=[],hash=createHash('sha256');
 for await(const raw of req){
  signal.throwIfAborted();let bytes=Buffer.from(raw);length+=bytes.length;
  if(length>LIMIT+2004)fail('media_length_mismatch',413);
  if(meta===undefined){
   prefix=Buffer.concat([prefix,bytes]);
   if(prefix.length<4)continue;
   headerSize??=prefix.readUInt32BE(0);if(headerSize<2||headerSize>2000)fail('media_header_invalid');
   if(prefix.length<4+headerSize)continue;
   try{meta=JSON.parse(prefix.subarray(4,4+headerSize).toString('utf8'));}catch{fail('invalid_json');}
   bytes=prefix.subarray(4+headerSize);prefix=Buffer.alloc(0);
  }
  received+=bytes.length;if(received>LIMIT)fail('media_length_mismatch',413);hash.update(bytes);parts.push(bytes);
 }
 if(meta===undefined)fail('media_header_invalid');
 return {meta,bytes:Buffer.concat(parts),sha256:hash.digest('hex'),length};
}

// One bounded operation, not a cache of completed authorizations. Large files
// retain the resumable multipart workflow; each retry reauthorizes its caller.
export function createSmallMediaHandler({db,sessionFactory,repository,privateAttachments,reference,changed,fetcher=globalThis.fetch,credential=req=>req.headers.cookie||'',now=()=>performance.now()}){
 db.exec('CREATE TABLE IF NOT EXISTS small_media_jobs(actor TEXT NOT NULL,submit_key TEXT NOT NULL,fingerprint TEXT NOT NULL,operation_json TEXT,fixed_json TEXT,PRIMARY KEY(actor,submit_key));');
 const flights=new Map();let receiving=0;
 return async(req,res)=>{
  if(new URL(req.url,'http://localhost').pathname!=='/business/v1/media-transfers')return false;
  const reply=(status,value)=>{if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
  let reserved=false;const ctl=new AbortController(),abort=()=>ctl.abort(),closed=()=>{if(!res.writableEnded)abort();};req.once('aborted',abort);res.once('close',closed);
  const timer=setTimeout(abort,120000);timer.unref?.();
  try{
   if(req.method!=='POST')fail('method_not_allowed',405);
   const key=req.headers['idempotency-key'];
   if(typeof key!=='string'||!key||key.length>180)fail('media_submission_invalid');
   if(receiving>=8)fail('media_transfer_busy',429);receiving++;reserved=true;
   const cookie=credential(req);let session=await sessionFactory(cookie);const actor=session.context.actor_id,authorizedAt=now();
   assertBusinessWrite(session.context,{});
   const name=JSON.stringify([actor,key]);if(flights.size>=8&&!flights.has(name))fail('media_transfer_busy',429);
   const frame=await readMediaFrame(req,ctl.signal),meta=frame.meta;
   if(!meta||Object.keys(meta).some(k=>!['file','peer','message'].includes(k)))fail('media_submission_invalid');
   const f=meta.file,body=meta.message,peer=meta.peer||'';
   if(f&&Object.keys(f).some(k=>!['name','mime','size','sha256','purpose','duration_ms'].includes(k)))fail('media_submission_invalid');
   if(typeof peer!=='string'||!body||typeof body!=='object'||Array.isArray(body)||!f||typeof f.name!=='string'||!f.name||f.name.length>200||/[\x00-\x1f]/.test(f.name)||typeof f.mime!=='string'||f.mime.length>200||/[\r\n]/.test(f.mime)||!Number.isSafeInteger(f.size)||f.size<1||f.size>LIMIT||!/^[a-f0-9]{64}$/.test(f.sha256)||!['voice','file'].includes(f.purpose)||(f.duration_ms!==undefined&&(!Number.isSafeInteger(f.duration_ms)||f.duration_ms<1)))fail('media_submission_invalid');
   assertBusinessWrite(session.context,body);
   if((body.recipient_username||'')!==peer||(body.attachment_ids||[]).length)fail('media_audience_mismatch',403);
   if(frame.bytes.length!==f.size||frame.sha256!==f.sha256)fail('media_integrity_mismatch',409);
   if(req.headers['content-length']!==undefined&&Number(req.headers['content-length'])!==frame.length)fail('media_length_mismatch');
   const fingerprint=sha(JSON.stringify([f,peer,body]));
   db.prepare('INSERT OR IGNORE INTO small_media_jobs VALUES(?,?,?,NULL,NULL)').run(actor,key,fingerprint);
   const row=()=>db.prepare('SELECT * FROM small_media_jobs WHERE actor=? AND submit_key=?').get(actor,key);
   if(row().fingerprint!==fingerprint)fail('idempotency_conflict',409);
   // Serialize identical retries. A cancelled request cannot cancel a new one.
   let waited=false;while(flights.has(name)){waited=true;await flights.get(name).catch(()=>{});}
   const run=(async()=>{
    let verifiedAt=authorizedAt;
    const check=()=>ctl.signal.throwIfAborted();
    const reauthorize=async()=>{check();const fresh=await sessionFactory(cookie);if(fresh.context.actor_id!==actor)fail('identity_changed',401);assertBusinessWrite(fresh.context,body);session=fresh;verifiedAt=now();};
    // Body receipt or an earlier retry may have taken a long time.
    if(waited||now()-verifiedAt>5000)await reauthorize();
    const ref=await reference(session.context,body,cookie,session);check();
    let file=new File([frame.bytes],f.name,{type:f.mime}),grant;
    const metadata={name:f.name,mime:f.mime,purpose:f.purpose,...(f.duration_ms?{duration_ms:f.duration_ms}:{})};
    if(peer){
     grant=privateAttachments.prepare(session.context,{...f,peer},key+'-source',session.context.member_roster||await session.directory());
     const source=await encryptedSource(file,grant,check);
     file=new File([await source.readPart(0,source.size)],source.name,{type:source.type});
    }
    const size=file.size,digest=peer?sha(Buffer.from(await file.arrayBuffer())):f.sha256;check();
    let operation=row().operation_json?JSON.parse(row().operation_json):null;
    let fixed=row().fixed_json?JSON.parse(row().fixed_json):null;
    if(!fixed){
     const fresh=!operation;
     if(!operation){
      const beginKey=key+'-upload',properties={employeeclient:peer?{internal_encrypted:true,name:file.name,mime:file.type}:metadata};
      const begun=await session.rpc('mem.upload.begin',{project_id:PROJECT,expected_revision:0,size,sha256:digest,logical_path:'员工客户端文件/'+sha(JSON.stringify([actor,beginKey]))+'/'+encodeURIComponent(file.name),origin_kind:'member_submission',producer:'employeeclient-native-candidate',properties,idempotency_key:beginKey},beginKey);
      if(!begun.operation_id)fail('upload_operation_missing',502);
      operation={project_id:PROJECT,operation_id:begun.operation_id};db.prepare('UPDATE small_media_jobs SET operation_json=? WHERE actor=? AND submit_key=?').run(JSON.stringify(operation),actor,key);
     }
     let status;if(!fresh)try{status=await session.rpc('mem.upload.put_status',operation);}catch(e){if(e.code!=='upload_mode_conflict')throw e;}
     check();
     if(!['staging_complete','completed'].includes(status?.state)){
      const ticket=await session.rpc('mem.upload.ticket',operation);check();
      if(ticket.state!=='uploading'||ticket.size!==size||ticket.ticket?.method!=='PUT')fail('upload_ticket_not_ready',503);
      const target=new URL(ticket.ticket.url);if(target.protocol!=='https:'||target.username||target.password)fail('invalid_upload_ticket',502);
      const put=await fetcher(target.href,{method:'PUT',headers:{...ticket.ticket.required_headers,'content-length':String(size)},body:Buffer.from(await file.arrayBuffer()),redirect:'error',signal:ctl.signal});
      if(!put.ok)fail('staging_put_failed',put.status);
     }
     check();await session.rpc('mem.upload.put_complete',operation);check();
     const published=await session.rpc('mem.upload.publish',operation);fixed=published.fixed_refs?.[0];
     if(published.state!=='published'||fixed?.project_id&&fixed.project_id!==PROJECT||fixed?.sha256!==digest||fixed?.size!==size)fail('publication_integrity_mismatch',502);
     db.prepare('UPDATE small_media_jobs SET fixed_json=? WHERE actor=? AND submit_key=?').run(JSON.stringify(fixed),actor,key);
    }
    check();if(now()-verifiedAt>5000)await reauthorize();
    let attachment;
    if(peer){attachment=privateAttachments.confirmPublished(session.context,grant.id,{...fixed,project_id:PROJECT}).attachment;}
    else{attachment={...metadata,id:fixed.material_id+':'+fixed.version_id,file_id:'m2_'+fixed.material_id,ver:Number(fixed.local_version_no)||1,size:f.size,sha256:f.sha256,fixed_ref:{...fixed,project_id:PROJECT},address:''};}
    const message={...body,attachment_ids:[attachment.id]};
    const receipt=repository.send(session.context,message,key,{members:session.context.member_roster||await session.directory(),reference:ref,attachments:[attachment]});
    changed({message_kind:'chat_message',group_files_changed:!peer&&isGroupFile(attachment),...(peer?{actors:[actor,peer],message_participants:[actor,peer]}:{})});
    return receipt;
   })();
   flights.set(name,run);try{reply(201,await run);}finally{if(flights.get(name)===run)flights.delete(name);}
  }catch(e){if(!res.headersSent)reply(e.status||503,{error_code:/^[a-z0-9_]+$/.test(e.code||'')?e.code:'media_transfer_unavailable'});}
  finally{if(reserved)receiving--;clearTimeout(timer);req.off('aborted',abort);res.off('close',closed);}
  return true;
 };
}

import {CHAT_RECORD_MIME} from '../../shared/chat-record.mjs';
import {randomUUID,randomBytes,createHash,createDecipheriv} from 'node:crypto';
import {once,EventEmitter} from 'node:events';
import {PROJECT,assertBusinessWrite} from './native-authority.mjs';
import {PRIVATE_BLOCK,encryptedSize,privateIV,privateAAD} from '../../shared/private-media.mjs';
const fail=(code,status=400)=>{throw Object.assign(Error(code),{code,status});};
const digest=b=>createHash('sha256').update(b).digest('hex');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function createPrivateAttachments(db){
 db.exec(`CREATE TABLE IF NOT EXISTS private_attachments(id TEXT PRIMARY KEY,actor TEXT NOT NULL,peer TEXT NOT NULL,submit_key TEXT NOT NULL,fingerprint TEXT NOT NULL,metadata_json TEXT NOT NULL,key_bytes BLOB NOT NULL,iv_prefix BLOB NOT NULL,fixed_json TEXT,UNIQUE(actor,submit_key));`);
 const own=(ctx,id)=>{const row=db.prepare('SELECT * FROM private_attachments WHERE id=? AND actor=?').get(id,ctx.actor_id);if(!row)fail('private_attachment_not_found',404);return row;};
 function descriptor(row){const meta=JSON.parse(row.metadata_json);return {id:'private:'+row.id,...meta,owner_username:row.actor,private_peer:row.peer,file_id:row.id,ver:1,address:''};}
 function accessible(ctx,id){
  const row=db.prepare('SELECT * FROM private_attachments WHERE id=?').get(id);
  if(!ctx.can_read||ctx.project_id!==PROJECT||!row||!row.fixed_json)fail('private_attachment_not_found',404);
  // Drafts belong only to the sender. The recipient gains access only after
  // an unrecalled, visible message actually carries this attachment.
  if(row.actor!==ctx.actor_id){
   if(row.peer!==ctx.actor_id)fail('private_attachment_not_found',404);
   const message=db.prepare(`SELECT 1 FROM messages m WHERE m.message_type='direct' AND m.actor_id=? AND m.recalled_at IS NULL AND EXISTS(SELECT 1 FROM json_each(m.recipients_json) WHERE value=?) AND EXISTS(SELECT 1 FROM json_each(m.attachments_json) a WHERE json_extract(a.value,'$.id')=? OR (json_extract(a.value,'$.mime')=? AND EXISTS(SELECT 1 FROM json_each(json_extract(a.value,'$.record_attachment_ids')) WHERE value=?))) AND NOT EXISTS(SELECT 1 FROM message_hides h WHERE h.message_id=m.id AND h.actor_id=?)`).get(row.actor,ctx.actor_id,'private:'+id,CHAT_RECORD_MIME,'private:'+id,ctx.actor_id);
   if(!message)fail('private_attachment_not_found',404);
  }return row;
 }
 return {
  prepare(ctx,body,key,members){
   assertBusinessWrite(ctx,body);
   if(ctx.project_id!==PROJECT||!key||key.length>200||!Array.isArray(members)||!members.some(m=>m.actor_id===body.peer&&m.can_read!==false))fail('private_recipient_invalid',403);
   if(typeof body.name!=='string'||!body.name.trim()||body.name.length>200||/[\x00-\x1f]/.test(body.name)||typeof body.mime!=='string'||body.mime.length>200||/[\r\n]/.test(body.mime)||!Number.isSafeInteger(body.size)||body.size<1||encryptedSize(body.size)>100*1024**3||!/^[a-f0-9]{64}$/.test(body.sha256||'')||!['file','voice'].includes(body.purpose||'file')||(body.duration_ms!==undefined&&(!Number.isSafeInteger(body.duration_ms)||body.duration_ms<1)))fail('private_attachment_invalid');
   const meta={name:body.name,mime:body.mime,size:body.size,sha256:body.sha256,purpose:body.purpose||'file',...(body.duration_ms?{duration_ms:body.duration_ms}:{})},fingerprint=digest(JSON.stringify([body.peer,meta]));
   db.prepare('INSERT OR IGNORE INTO private_attachments VALUES(?,?,?,?,?,?,?,?,NULL)').run(randomUUID(),ctx.actor_id,body.peer,key,fingerprint,JSON.stringify(meta),randomBytes(32),randomBytes(8));
   const row=db.prepare('SELECT * FROM private_attachments WHERE actor=? AND submit_key=?').get(ctx.actor_id,key);if(row.fingerprint!==fingerprint)fail('idempotency_conflict',409);
   return {id:row.id,size:meta.size,key_base64:Buffer.from(row.key_bytes).toString('base64'),iv_prefix:Buffer.from(row.iv_prefix).toString('base64'),attachment:row.fixed_json?descriptor(row):null};
  },
  async bind(ctx,id,body,session){
   assertBusinessWrite(ctx,body);const row=own(ctx,id),f=body.fixed_ref;
   if(!f||!UUID.test(f.material_id||'')||!UUID.test(f.version_id||'')||!/^[a-f0-9]{64}$/.test(f.sha256||'')||f.size!==encryptedSize(JSON.parse(row.metadata_json).size))fail('private_fixed_reference_invalid');
   const fixed={project_id:PROJECT,material_id:f.material_id,version_id:f.version_id,sha256:f.sha256,size:f.size};
   if(row.fixed_json&&row.fixed_json!==JSON.stringify(fixed))fail('private_fixed_reference_conflict',409);
   const page=await session.rpc('mem.version.read',{project_id:PROJECT,material_id:fixed.material_id,version_id:fixed.version_id,offset:0,limit:1,encoding:'base64'});
   if(['material_id','version_id','sha256','size'].some(k=>page.fixed_ref?.[k]!==fixed[k]))fail('private_fixed_reference_changed',409);
   db.prepare('UPDATE private_attachments SET fixed_json=? WHERE id=? AND actor=? AND fixed_json IS NULL').run(JSON.stringify(fixed),id,ctx.actor_id);
   return {attachment:descriptor(own(ctx,id))};
  },
  // Called only with the immutable publication receipt from our own bounded
  // upload operation. HTTP bind still independently reads Mem's fixed source.
  confirmPublished(ctx,id,f){
   assertBusinessWrite(ctx,{});const row=own(ctx,id);
   if(f.project_id!==PROJECT||!UUID.test(f.material_id||'')||!UUID.test(f.version_id||'')||!/^[a-f0-9]{64}$/.test(f.sha256||'')||f.size!==encryptedSize(JSON.parse(row.metadata_json).size))fail('private_fixed_reference_invalid');
   const fixed={project_id:PROJECT,material_id:f.material_id,version_id:f.version_id,sha256:f.sha256,size:f.size};
   if(row.fixed_json&&row.fixed_json!==JSON.stringify(fixed))fail('private_fixed_reference_conflict',409);
   db.prepare('UPDATE private_attachments SET fixed_json=? WHERE id=? AND actor=? AND fixed_json IS NULL').run(JSON.stringify(fixed),id,ctx.actor_id);
   return {attachment:descriptor(own(ctx,id))};
  },
  resolve(ctx,id,peer){const row=own(ctx,id.replace(/^private:/,''));if(!row.fixed_json||!peer||row.peer!==peer)fail('private_attachment_audience_mismatch',403);return descriptor(row);},
  head(ctx,id){return {attachment:descriptor(accessible(ctx,id))};},
  async readVoice(ctx,id,session,signal,maxBytes){
   const attachment=this.head(ctx,id).attachment;
   if(attachment.purpose!=='voice'&&!attachment.mime.startsWith('audio/'))fail('voice_asr_source_invalid',422);
   if(attachment.size>maxBytes||attachment.duration_ms>180000)fail('voice_asr_audio_too_large',413);
   const res=new EventEmitter(),parts=[];let total=0;
   res.writeHead=()=>{};res.write=part=>{total+=part.length;if(total>maxBytes)fail('voice_asr_audio_too_large',413);parts.push(Buffer.from(part));return true;};res.end=()=>{};
   await this.stream(ctx,id,session,res,signal);
   this.head(ctx,id);return {bytes:Buffer.concat(parts),mime:attachment.mime};
  },
  async stream(ctx,id,session,res,signal){
   const row=accessible(ctx,id),meta=JSON.parse(row.metadata_json),fixed=JSON.parse(row.fixed_json);
   const upstream=await session.fileStream(fixed,signal);if(!upstream.ok||!upstream.body)fail('private_source_unavailable',502);
   const reader=upstream.body.getReader(),hash=createHash('sha256'),cipherHash=createHash('sha256');let pending=Buffer.alloc(0),index=0,total=0,cipherTotal=0;
   res.writeHead(200,{'content-type':'application/octet-stream','content-length':meta.size,'cache-control':'private, no-store','x-content-type-options':'nosniff','content-disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(meta.name)});
   try{
    for(;;){signal?.throwIfAborted();const part=await reader.read();if(part.done)break;cipherTotal+=part.value.length;if(cipherTotal>fixed.size)fail('private_cipher_length_mismatch',502);cipherHash.update(part.value);pending=Buffer.concat([pending,part.value]);
     while(total<meta.size){const plainSize=Math.min(PRIVATE_BLOCK,meta.size-total),length=plainSize+16;if(pending.length<length)break;
      const block=pending.subarray(0,length);pending=pending.subarray(length);const decrypt=createDecipheriv('aes-256-gcm',row.key_bytes,privateIV(row.iv_prefix,index));decrypt.setAAD(privateAAD(row.id,index,meta.size));decrypt.setAuthTag(block.subarray(plainSize));
      const plain=Buffer.concat([decrypt.update(block.subarray(0,plainSize)),decrypt.final()]);hash.update(plain);total+=plain.length;index++;
      if(!res.write(plain))await once(res,'drain',{signal});
     }
    }
    if(pending.length||cipherTotal!==fixed.size||total!==meta.size||cipherHash.digest('hex')!==fixed.sha256||hash.digest('hex')!==meta.sha256)fail('private_integrity_mismatch',502);
    res.end();
   }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  }
 };
}

import {createHash} from 'node:crypto';
import {PROJECT,assertBusinessWrite} from './native-authority.mjs';
const parse=value=>typeof value==='string'?JSON.parse(value):value;
const json=JSON.stringify;
const failure=code=>{throw Object.assign(Error(code),{code,status:409});};
export function importSharedCommunication(db,context,packet,fixed){
 assertBusinessWrite(context,{});
 if(packet.project_id!==PROJECT||fixed.project_id!==PROJECT||!Array.isArray(packet.messages)||!Array.isArray(packet.member_mapping))failure('legacy_shared_scope_mismatch');
 const mapping=new Map();for(const m of packet.member_mapping){if(mapping.has(m.legacy_username)&&mapping.get(m.legacy_username)!==m.actor_id)failure('legacy_actor_ambiguous');mapping.set(m.legacy_username,m.actor_id);}
 const fingerprint=fixed.sha256,key=fixed.material_id+':'+fixed.version_id;
 db.exec('BEGIN IMMEDIATE');
 try{
  const existing=db.prepare("SELECT result_json,fingerprint FROM receipts WHERE operation='migration.shared' AND submit_key=? LIMIT 1").get(key);
  if(existing){if(existing.fingerprint!==fingerprint)failure('legacy_source_changed');db.exec('COMMIT');return {...parse(existing.result_json),replayed:true};}
  const ids=new Set(packet.messages.map(m=>m.id));let imported=0;
  for(const m of packet.messages){
   const actor=mapping.get(m.author_username);if(!actor)failure('legacy_author_unmapped');
   if(db.prepare('SELECT 1 FROM messages WHERE id=?').get(m.id))failure('legacy_message_id_collision');
   const mentions=parse(m.mention_usernames||'[]'),attachments=parse(m.attachments_json||'[]');
   const visibleAttachments=attachments.map(a=>({...a,owner_username:undefined,address:'',source_unavailable:true,availability:'original_missing'}));
   const meta={legacy_source:fixed,legacy_seq:m.seq,legacy_project_id:m.project_id??null,legacy_task_id:m.task_id??null,
    unmapped_mention_count:mentions.filter(x=>!mapping.has(x)).length};
   if(m.reply_to_id&&!ids.has(m.reply_to_id))failure('legacy_reply_source_missing');
   db.prepare("INSERT INTO messages(id,actor_id,display_name,body,mentions,reference_json,attachments_json,created_at,recalled_at,message_type,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,'chat',?)")
    .run(m.id,actor,m.author_name||actor,m.body||'',json(mentions.map(x=>mapping.get(x)).filter(Boolean)),null,json(visibleAttachments),m.created_at,m.recalled_at??null,json(meta));
   db.prepare('INSERT INTO message_changes(message_id,audience_actor,created_at) VALUES(?,?,?)').run(m.id,'',m.created_at);imported++;
  }
  for(const m of packet.messages)if(m.reply_to_id)db.prepare('UPDATE messages SET reply_id=? WHERE id=?').run(m.reply_to_id,m.id);
  const result={state:'imported',shared_messages:imported,attachment_reference_gaps:packet.reference_gaps?.length||0,source_fixed_ref:fixed};
  db.prepare('INSERT INTO receipts VALUES(?,?,?,?,?)').run(context.actor_id,'migration.shared',key,fingerprint,json(result));db.exec('COMMIT');return result;
 }catch(e){db.exec('ROLLBACK');throw e;}
}

export function importOwnerProjection(db,context,packet,mapping,sourceBytes){
 assertBusinessWrite(context,{});if(packet.owner_actor_id!==context.actor_id)failure('legacy_projection_owner_mismatch');
 if(!Array.isArray(packet.notifications)||!Array.isArray(packet.announcements))failure('legacy_private_packet_shape_unrecognized');
 const hash=createHash('sha256').update(sourceBytes).digest('hex'),key='owner-projection:'+hash;
 db.exec('BEGIN IMMEDIATE');
 try{
  const old=db.prepare("SELECT result_json FROM receipts WHERE actor_id=? AND operation='migration.owner' AND submit_key=?").get(context.actor_id,key);
  if(old){db.exec('COMMIT');return {...parse(old.result_json),replayed:true};}
  const actor=legacy=>mapping.get(legacy)||('historical-unresolved:'+createHash('sha256').update(String(legacy||'unknown')).digest('hex').slice(0,24));
  const announceIds=new Set();
  for(const a of packet.announcements){
   if(db.prepare('SELECT 1 FROM messages WHERE id=?').get(a.id))failure('legacy_announcement_id_collision');
   const meta={title:a.title||'历史公告',priority:a.priority||'normal',expires_at:a.expires_at??null,legacy_source_sha256:hash};
   db.prepare("INSERT INTO messages(id,actor_id,display_name,body,mentions,attachments_json,created_at,message_type,recipients_json,metadata_json) VALUES(?,?,?,?,?,?,?,'announcement',?,?)")
    .run(a.id,actor(a.publisher_username),a.publisher_name||'历史公告',a.body||'','[]','[]',a.created_at,json([context.actor_id]),json(meta));announceIds.add(a.id);
  }
  let count=0;
  for(const n of packet.notifications){
   if(n.recipient_username&&mapping.get(n.recipient_username)!==context.actor_id)failure('legacy_notification_owner_mismatch');
   let target=n.object_id;
   const original=db.prepare('SELECT * FROM messages WHERE id=?').get(target);
   if(!(n.kind==='chat_message'&&original?.message_type==='chat')&&!announceIds.has(target)){
    target='legacy_notice_'+n.id;
    db.prepare("INSERT INTO messages(id,actor_id,display_name,body,mentions,attachments_json,created_at,message_type,recipients_json,metadata_json) VALUES(?,?,?,?,?,?,?,'legacy_notice',?,?)")
     .run(target,actor(n.actor_username),n.actor_nickname||'历史记录',n.summary||'','[]','[]',n.created_at,json([context.actor_id]),json({title:n.title||'历史通知',legacy_kind:n.kind,legacy_object_id:n.object_id,legacy_source_sha256:hash}));
   }
   const ts=n.updated_at??n.created_at;
   db.prepare('INSERT INTO notifications(id,recipient_actor,message_id,title,summary,snapshot_json,created_at,updated_at,version,read_at,acked_at,hidden_at,pinned_at,snooze_until) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(n.id,context.actor_id,target,n.title||'历史通知',n.summary||'',json({silent:true,legacy_import:true}),n.created_at,ts,n.version||1,n.read_at??null,n.acked_at??null,n.hidden_at??null,n.pinned_at??null,n.snooze_until??null);
   db.prepare('INSERT INTO notification_changes(notification_id,recipient_actor) VALUES(?,?)').run(n.id,context.actor_id);count++;
  }
  const result={state:'imported',owner_actor_id:context.actor_id,owner_notifications:count,owner_announcements:announceIds.size,source_sha256:hash};
  db.prepare('INSERT INTO receipts VALUES(?,?,?,?,?)').run(context.actor_id,'migration.owner',key,hash,json(result));db.exec('COMMIT');return result;
 }catch(e){db.exec('ROLLBACK');throw e;}
}

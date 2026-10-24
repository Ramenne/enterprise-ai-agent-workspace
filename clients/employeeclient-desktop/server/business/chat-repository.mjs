import {messageAttention,isUnreadMessageNotice} from '../../src/domain/messageBadge.mjs';
import {createInspirations} from './inspiration-repository.mjs';
import {createFeedbackRepository} from './feedback-repository.mjs';
import {createMemberProfiles} from './member-profiles.mjs';
import {isGroupFile} from '../../shared/chat-media-purpose.mjs';
import {attachmentSearchKind,hasMessageLink,MESSAGE_KINDS} from '../../shared/chat-search.mjs';
import {notificationTarget} from './notification-target.mjs';
import {installChatSearchIndex,searchIndexTerm} from './chat-search-index.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {PROJECT,assertBusinessWrite,assertActorNeutralBody} from './native-authority.mjs';
const fail=(code,status=400)=>{throw Object.assign(new Error(code),{code,status});};
const integer=(v,defaultValue)=>{const n=v===undefined?defaultValue:Number(v);if(!Number.isSafeInteger(n)||n<0)fail('invalid_cursor');return n;};
const encode=JSON.stringify,decode=JSON.parse;

// This is a EmployeeClient business store, not a second V8 work/project authority.
export const CHAT_SCHEMA=`
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,
 actor_id TEXT NOT NULL,display_name TEXT NOT NULL,body TEXT NOT NULL,mentions TEXT NOT NULL,
 reply_id TEXT REFERENCES messages(id),reference_json TEXT,attachments_json TEXT NOT NULL,
 created_at INTEGER NOT NULL,recalled_at INTEGER);
CREATE TABLE IF NOT EXISTS message_hides(actor_id TEXT NOT NULL,message_id TEXT NOT NULL REFERENCES messages(id),hidden_at INTEGER NOT NULL,PRIMARY KEY(actor_id,message_id));
CREATE TABLE IF NOT EXISTS message_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,message_id TEXT NOT NULL REFERENCES messages(id),audience_actor TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS notifications(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,
 recipient_actor TEXT NOT NULL,message_id TEXT NOT NULL REFERENCES messages(id),title TEXT NOT NULL,summary TEXT NOT NULL,
 snapshot_json TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,version INTEGER NOT NULL DEFAULT 1,
 read_at INTEGER,acked_at INTEGER,hidden_at INTEGER,pinned_at INTEGER,snooze_until INTEGER);
CREATE TABLE IF NOT EXISTS notification_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,notification_id TEXT NOT NULL REFERENCES notifications(id),recipient_actor TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS delivery_outbox(id TEXT NOT NULL PRIMARY KEY,notification_id TEXT NOT NULL REFERENCES notifications(id),recipient_actor TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS receipts(actor_id TEXT NOT NULL,operation TEXT NOT NULL,submit_key TEXT NOT NULL,fingerprint TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(actor_id,operation,submit_key));
CREATE INDEX IF NOT EXISTS messages_date_order ON messages(created_at DESC,seq DESC);
CREATE INDEX IF NOT EXISTS message_changes_audience ON message_changes(audience_actor,seq);
CREATE INDEX IF NOT EXISTS notifications_recipient ON notifications(recipient_actor,seq);
CREATE INDEX IF NOT EXISTS notification_changes_recipient ON notification_changes(recipient_actor,seq);
CREATE TABLE IF NOT EXISTS conversation_preferences(actor TEXT NOT NULL,peer TEXT NOT NULL,pinned INTEGER,preview_after INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(actor,peer));
`;

export function createChatRepository(db,{now=Date.now}={}) {
 db.exec(CHAT_SCHEMA);
 const retired=db.prepare('SELECT id,recipient_actor FROM notifications WHERE snooze_until IS NOT NULL').all();
 if(retired.length){db.exec('BEGIN IMMEDIATE');try{for(const n of retired){db.prepare("UPDATE notifications SET snooze_until=NULL,snapshot_json=json_set(snapshot_json,'$.silent',json('true'),'$.reminder',json('false')),version=version+1,updated_at=? WHERE id=?").run(now(),n.id);db.prepare('INSERT INTO notification_changes(notification_id,recipient_actor) VALUES(?,?)').run(n.id,n.recipient_actor);db.prepare("UPDATE delivery_outbox SET state='cancelled' WHERE notification_id=? AND state='snoozed'").run(n.id);}db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}

 db.function('employeeclient_attachment_kind',{deterministic:true},(purpose,name,mime)=>attachmentSearchKind({purpose,name,mime}));
 db.function('employeeclient_has_link',{deterministic:true},body=>Number(hasMessageLink(body)));
 db.function('employeeclient_is_group_file',{deterministic:true},(purpose,name,mime)=>Number(isGroupFile({purpose,name,mime})));
 const cols=new Set(db.prepare('PRAGMA table_info(messages)').all().map(c=>c.name));
 if(!cols.has('message_type'))db.exec("ALTER TABLE messages ADD COLUMN message_type TEXT NOT NULL DEFAULT 'chat'");
 if(!cols.has('recipients_json'))db.exec('ALTER TABLE messages ADD COLUMN recipients_json TEXT');
 if(!cols.has('metadata_json'))db.exec("ALTER TABLE messages ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'");
 installChatSearchIndex(db);
 const read=ctx=>{if(ctx?.project_id!==PROJECT||!ctx.can_read||!ctx.actor_id)fail('project_read_denied',403);};
 const transact=fn=>{db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}};
 function write(ctx,op,key,body,run){
  read(ctx);if(op.startsWith('notification.'))assertActorNeutralBody(body);else assertBusinessWrite(ctx,body);if(typeof key!=='string'||!key||key.length>200)fail('idempotency_required');
  const hash=createHash('sha256').update(encode(body)).digest('hex');
  return transact(()=>{const old=db.prepare('SELECT * FROM receipts WHERE actor_id=? AND operation=? AND submit_key=?').get(ctx.actor_id,op,key);
   if(old){if(old.fingerprint!==hash)fail('idempotency_conflict',409);return decode(old.result_json);}
   const result=run();db.prepare('INSERT INTO receipts VALUES(?,?,?,?,?)').run(ctx.actor_id,op,key,hash,encode(result));return result;});
 }
 const changed=(id,audience='')=>db.prepare('INSERT INTO message_changes(message_id,audience_actor,created_at) VALUES(?,?,?)').run(id,audience,now());
 const noticeChanged=(n,effect=false)=>{
  const change=db.prepare('INSERT INTO notification_changes(notification_id,recipient_actor) VALUES(?,?)').run(n.id,n.recipient_actor);
  if(effect&&db.prepare("SELECT 1 FROM messages m JOIN notifications n ON n.message_id=m.id WHERE n.id=? AND m.message_type IN ('chat','direct','announcement','announcement_reply')").get(n.id)){
   // A state change is durable work, including after the original alert was
   // accepted. Coalesce queued older effects; never delete notification history.
   db.prepare("UPDATE delivery_outbox SET state='superseded' WHERE notification_id=? AND id LIKE 'state:%' AND state IN ('queued','sending','failed')").run(n.id);
   db.prepare('INSERT OR IGNORE INTO delivery_outbox VALUES(?,?,?,?,?)').run('state:'+n.id+':'+change.lastInsertRowid,n.id,n.recipient_actor,'queued',now());
  }
 };
 const hidden=(id,actor)=>!!db.prepare('SELECT 1 FROM message_hides WHERE actor_id=? AND message_id=?').get(actor,id);
 function view(row,ctx,quote=false){
  if(!row)return null;
  if(row.message_type!=='chat'&&row.actor_id!==ctx.actor_id&&!decode(row.recipients_json||'[]').includes(ctx.actor_id))fail('message_not_found',404);
  const isHidden=hidden(row.id,ctx.actor_id),removed=isHidden||row.recalled_at!==null;
  const version=db.prepare("SELECT COALESCE(MAX(seq),0) n FROM message_changes WHERE message_id=? AND (audience_actor='' OR audience_actor=?)").get(row.id,ctx.actor_id).n;
  const ref=removed?null:row.reference_json?decode(row.reference_json):null;
  const output={id:row.id,seq:row.seq,author_username:row.actor_id,author_name:row.display_name,body:removed?'':row.body,
   created_at:row.created_at,...(row.message_type==='direct'?{conversation_peer:decode(row.recipients_json).find(a=>a!==ctx.actor_id)||ctx.actor_id}:{}),change_version:version,hidden:isHidden,recalled:row.recalled_at!==null,
   recall_deadline_at:row.created_at+120000,context:ref,project_id:ref?.project_id??null,work_item_id:ref?.work_item_id??null,
   attachments:removed?[]:decode(row.attachments_json),mention_usernames:removed?[]:decode(row.mentions),
   allowed_actions:isHidden?[]:['hide',...(!removed&&row.actor_id===ctx.actor_id&&now()<=row.created_at+120000?['recall']:[])]};
  return {...output,reply_to:quote||removed||!row.reply_id?null:view(db.prepare('SELECT * FROM messages WHERE id=?').get(row.reply_id),ctx,true)};
 }
 function get(ctx,id){read(ctx);const message=view(db.prepare('SELECT * FROM messages WHERE id=?').get(id),ctx);if(!message)fail('message_not_found',404);return message;}
 function send(ctx,body,key,{members,reference=null,attachments=[]}={}){
  // Directory and Mem/work refs must be resolved by the native-authority adapter,
  // never by trusting member-supplied names, recipients or attachment metadata.
  if(!Array.isArray(members)||members.some(m=>!m.actor_id))fail('member_directory_unavailable',503);
  const actors=new Set(members.filter(m=>m.can_read!==false).map(m=>m.actor_id));if(!actors.has(ctx.actor_id))fail('sender_not_in_directory',403);
  const peer=body.recipient_username||'';if(peer&&(typeof peer!=='string'||!actors.has(peer)))fail('recipient_unavailable',403);
  const audience=peer?[...new Set([ctx.actor_id,peer])]:[...actors];
  if(attachments.some(a=>peer?!a.id.startsWith('private:')||a.owner_username!==ctx.actor_id||a.private_peer!==peer:a.id.startsWith('private:')))fail('attachment_audience_mismatch',403);
  const text=typeof body.body==='string'?body.body.trim():'';if(text.length>20000||(!text&&!attachments.length)||attachments.length>6)fail('invalid_message');
  if(body.task_id!==undefined||body.plan_id!==undefined||body.code_id!==undefined)fail('retired_task_reference');
  const mentions=body.mention_usernames??[];if(!Array.isArray(mentions)||mentions.length>50||mentions.some(a=>typeof a!=='string'||!audience.includes(a)))fail('invalid_mention');
  if(reference&&(reference.project_id!==PROJECT||reference.visibility!=='team'))fail('reference_audience_mismatch',403);
  if(attachments.some(a=>!a.id.startsWith('private:')&&(a.fixed_ref?.project_id!==PROJECT||!a.fixed_ref.material_id||!a.fixed_ref.version_id)))fail('attachment_reference_invalid');
  const canonical={...body,body:text,mention_usernames:[...new Set(mentions)].sort()};
  const result=write(ctx,'message.send',key,canonical,()=>{
   const reply=body.reply_to_id?db.prepare('SELECT * FROM messages WHERE id=?').get(body.reply_to_id):null;
   if(body.reply_to_id&&(!reply||reply.message_type!==(peer?'direct':'chat')||(peer&&(!decode(reply.recipients_json||'[]').includes(ctx.actor_id)||!decode(reply.recipients_json||'[]').includes(peer)||peer===ctx.actor_id&&decode(reply.recipients_json||'[]').length!==1))||reply.recalled_at!==null||hidden(reply.id,ctx.actor_id)))fail('reply_unavailable');
   const id=randomUUID(),ts=now();db.prepare('INSERT INTO messages(id,actor_id,display_name,body,mentions,reply_id,reference_json,attachments_json,created_at,message_type,recipients_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(id,ctx.actor_id,ctx.display_name,text,encode(canonical.mention_usernames),reply?.id??null,reference?encode(reference):null,encode(attachments),ts,peer?'direct':'chat',peer?encode(audience):null);if(peer){for(const actor of audience)changed(id,actor);}else changed(id);
   for(const actor of audience){if(actor===ctx.actor_id)continue;const nid=randomUUID(),attention=mentions.includes(actor)?'mention':reply?.actor_id===actor?'reply':'normal';
    const snapshot={attention,silent:false,...(peer?{conversation_peer:ctx.actor_id}:{}),actor_id:ctx.actor_id,reply_to_id:reply?.id??null,has_group_files:!peer&&attachments.some(isGroupFile)};
    db.prepare('INSERT INTO notifications(id,recipient_actor,message_id,title,summary,snapshot_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
     .run(nid,actor,id,ctx.display_name,text.slice(0,500)||'发送了附件',encode(snapshot),ts,ts);
    noticeChanged({id:nid,recipient_actor:actor});db.prepare('INSERT INTO delivery_outbox VALUES(?,?,?,?,?)').run(randomUUID(),nid,actor,'queued',ts);
   }
   return {state:'published',message_id:id,receipt_id:randomUUID()};
  });return {...result,message:get(ctx,result.message_id)};
 }
 function change(ctx,id,action,key){
  if(!['hide','recall'].includes(action))fail('unsupported_message_action');
  const result=write(ctx,'message.'+action,key,{message_id:id},()=>{
   const row=db.prepare('SELECT * FROM messages WHERE id=?').get(id);if(!row||!['chat','direct'].includes(row.message_type))fail('message_not_found',404);
   view(row,ctx);const ts=now();
   if(action==='recall'){
    if(row.actor_id!==ctx.actor_id)fail('recall_denied',403);if(row.recalled_at===null&&ts>row.created_at+120000)fail('recall_expired',409);
    db.prepare('UPDATE messages SET recalled_at=COALESCE(recalled_at,?) WHERE id=?').run(ts,id);if(row.message_type==='direct'){for(const actor of decode(row.recipients_json))changed(id,actor);}else changed(id);
   }else{db.prepare('INSERT OR IGNORE INTO message_hides VALUES(?,?,?)').run(ctx.actor_id,id,ts);changed(id,ctx.actor_id);}
   const notices=db.prepare('SELECT * FROM notifications WHERE message_id=?'+(action==='hide'?' AND recipient_actor=?':'')).all(id,...(action==='hide'?[ctx.actor_id]:[]));
   for(const n of notices){db.prepare("UPDATE notifications SET summary='',title=?,snapshot_json=?,hidden_at=?,version=version+1,updated_at=? WHERE id=?")
    .run(action==='hide'?'消息已删除':'消息已撤回',encode({silent:true,message_change:action,has_group_files:row.message_type==='chat'&&decode(row.attachments_json).some(isGroupFile)}),ts,ts,n.id);noticeChanged(n,true);
    db.prepare("UPDATE delivery_outbox SET state='expired' WHERE notification_id=? AND id NOT LIKE 'state:%' AND state IN ('queued','sending','failed')").run(n.id);}
   return {state:'updated',message_id:id,receipt_id:randomUUID()};
  });return {...result,message:get(ctx,id)};
 }
 function messages(ctx,q={},filesOnly=false){
  read(ctx);const limit=Math.min(integer(q.limit,50),100);if(!limit)fail('invalid_limit');
  if(q.after!==undefined&&q.before!==undefined)fail('exclusive_cursors');
  if(filesOnly&&q.after!==undefined)fail('invalid_file_cursor');
  const dated=filesOnly&&typeof q.before==='string'?/^(\d+):(\d+)$/.exec(q.before):null;
  const ascending=q.after!==undefined,cursor=integer(dated?dated[2]:ascending?q.after:q.before,ascending?0:Number.MAX_SAFE_INTEGER);
  const peer=q.peer||'';if(peer&&(typeof peer!=='string'||peer.length>128||filesOnly))fail('invalid_peer');
  const clauses=[peer?"message_type='direct'":"message_type='chat'",dated?'(created_at<? OR (created_at=? AND seq<?))':'seq'+(ascending?'>':'<')+'?'],args=dated?[integer(dated[1],0),integer(dated[1],0),cursor]:[cursor];
  if(peer===ctx.actor_id){clauses.push('actor_id=? AND json_array_length(recipients_json)=1');args.push(ctx.actor_id);}
  if(peer){clauses.push('EXISTS(SELECT 1 FROM json_each(recipients_json) WHERE value=?) AND EXISTS(SELECT 1 FROM json_each(recipients_json) WHERE value=?)');args.push(ctx.actor_id,peer);}
  if(q.kind!==undefined){if(!MESSAGE_KINDS.includes(q.kind))fail('invalid_message_kind');if(q.kind==='links')clauses.push('employeeclient_has_link(body)=1');else{clauses.push("EXISTS(SELECT 1 FROM json_each(attachments_json) WHERE employeeclient_attachment_kind(json_extract(value,'$.purpose'),json_extract(value,'$.name'),json_extract(value,'$.mime'))=?)");args.push(q.kind);}}
  if(q.author){if(typeof q.author!=='string'||q.author.length>128)fail('invalid_author');clauses.push('actor_id=?');args.push(q.author);}
  if(filesOnly)clauses.push("EXISTS(SELECT 1 FROM json_each(attachments_json) WHERE employeeclient_is_group_file(json_extract(value,'$.purpose'),json_extract(value,'$.name'),json_extract(value,'$.mime'))=1)");
  for(const k of ['project_id','work_item_id'])if(q[k]!==undefined){if(typeof q[k]!=='string'||q[k].length>128)fail('invalid_reference_filter');clauses.push("json_extract(reference_json,'$."+k+"')=?");args.push(q[k]);}
  if(q.q!==undefined){if(typeof q.q!=='string'||q.q.length>200)fail('invalid_search');
   const term=searchIndexTerm(db,q.q);if(term){clauses.push('seq IN (SELECT rowid FROM message_search_index WHERE message_search_index MATCH ?)');args.push(term);}
   clauses.push(`(instr(lower(body),lower(?))>0 OR EXISTS(SELECT 1 FROM json_each(attachments_json) WHERE instr(lower(json_extract(value,'$.name')),lower(?))>0))`);args.push(q.q,q.q);}
  for(const [key,operator] of [['created_from','>='],['created_until','<']])if(q[key]!==undefined){const value=Number(q[key]);if(!Number.isSafeInteger(value)||value<0)fail('invalid_date_filter');clauses.push('created_at'+operator+'?');args.push(value);}
  if(q.related==='mentions'){clauses.push('EXISTS(SELECT 1 FROM json_each(mentions) WHERE value=?)');args.push(ctx.actor_id);}
  else if(q.related==='replies'){clauses.push('reply_id IN (SELECT id FROM messages WHERE actor_id=?)');args.push(ctx.actor_id);}
  else if(q.related!==undefined)fail('invalid_related_filter');
  if(clauses.length>2){clauses.push('recalled_at IS NULL AND NOT EXISTS(SELECT 1 FROM message_hides h WHERE h.message_id=messages.id AND h.actor_id=?)');args.push(ctx.actor_id);}
  const rows=db.prepare('SELECT * FROM messages WHERE '+clauses.join(' AND ')+' ORDER BY '+(filesOnly?'created_at DESC,seq DESC':'seq '+(ascending?'ASC':'DESC'))+' LIMIT ?').all(...args,limit+1);
  const more=rows.length>limit,page=rows.slice(0,limit);if(!ascending&&!filesOnly)page.reverse();
  return {messages:page.map(r=>view(r,ctx)),next_cursor:page.at(-1)?.seq??(ascending?cursor:0),oldest_cursor:filesOnly?(page.length?page.at(-1).created_at+':'+page.at(-1).seq:null):page[0]?.seq??cursor,
   has_more:ascending&&more,has_more_old:!ascending&&more,sync_cursor:db.prepare("SELECT COALESCE(MAX(seq),0) n FROM message_changes WHERE audience_actor='' OR audience_actor=?").get(ctx.actor_id).n};
 }
 function files(ctx,q={}){
  // Page complete messages, then project fixed attachments. This retains the
  // message authority and never creates a second file registry.
  const page=messages(ctx,{...q,before:q.before,limit:q.limit||50},true);
  return {files:page.messages.flatMap(m=>m.hidden||m.recalled?[]:m.attachments.filter(isGroupFile).map(a=>({...a,message_id:m.id,message_seq:m.seq,created_at:m.created_at,project_id:m.project_id,work_item_id:m.work_item_id}))),next_cursor:page.has_more_old?String(page.oldest_cursor):null};
 }
 function changes(ctx,after=0,limit=100,peer=''){read(ctx);const n=Math.min(integer(limit,100),100);if(!n)fail('invalid_limit');const rows=db.prepare("SELECT * FROM message_changes WHERE seq>? AND (audience_actor='' OR audience_actor=?) ORDER BY seq LIMIT ?").all(integer(after,0),ctx.actor_id,n+1);
  return {changes:rows.slice(0,n).filter(r=>{const row=db.prepare('SELECT actor_id,message_type,recipients_json FROM messages WHERE id=?').get(r.message_id);return peer?row?.message_type==='direct'&&decode(row.recipients_json||'[]').includes(ctx.actor_id)&&decode(row.recipients_json||'[]').includes(peer)&&(peer!==ctx.actor_id||row.actor_id===ctx.actor_id&&decode(row.recipients_json).length===1):row?.message_type==='chat';}).map(r=>({change_seq:r.seq,message:get(ctx,r.message_id)})),next_change_cursor:rows.slice(0,n).at(-1)?.seq??integer(after,0),has_more:rows.length>n};}
 function conversations(ctx,members){
  read(ctx);const direct=db.prepare("SELECT * FROM messages WHERE message_type='direct' AND EXISTS(SELECT 1 FROM json_each(recipients_json) WHERE value=?) ORDER BY seq DESC").all(ctx.actor_id);
  const latest=new Map();for(const row of direct){if(hidden(row.id,ctx.actor_id))continue;const peer=decode(row.recipients_json).find(a=>a!==ctx.actor_id)||ctx.actor_id;if(latest.has(peer))continue;latest.set(peer,view(row,ctx));}
  const group=db.prepare("SELECT * FROM messages WHERE message_type='chat' AND NOT EXISTS(SELECT 1 FROM message_hides WHERE message_id=messages.id AND actor_id=?) ORDER BY seq DESC LIMIT 1").get(ctx.actor_id);
  const unread=db.prepare("SELECT n.*,n.version AS update_version FROM notifications n JOIN messages m ON m.id=n.message_id WHERE n.recipient_actor=? AND n.read_at IS NULL AND n.acked_at IS NULL AND n.hidden_at IS NULL AND m.message_type IN ('chat','direct')").all(ctx.actor_id).filter(n=>isUnreadMessageNotice(publicNotice(n),ctx.actor_id,now()));
  const counts=new Map();for(const item of unread){const row=db.prepare('SELECT actor_id,message_type,recipients_json FROM messages WHERE id=?').get(item.message_id);const key=row.message_type==='direct'?decode(row.recipients_json).find(a=>a!==ctx.actor_id)||ctx.actor_id:'';counts.set(key,(counts.get(key)||0)+1);}
  const preferences=new Map(db.prepare('SELECT * FROM conversation_preferences WHERE actor=?').all(ctx.actor_id).map(r=>[r.peer,r]));
  const peers=members?new Map(members.filter(m=>m.actor_id!==ctx.actor_id&&m.can_read!==false).map(m=>[m.actor_id,m.display_name||m.actor_id])):new Map([...latest.keys()].map(p=>[p,p]));
  if(members)peers.set(ctx.actor_id,'文件传输助手');
  const row=(peer,message,name)=>{const pref=preferences.get(peer),cutoff=pref?.preview_after||0;return {peer,peer_name:name,message:message&&message.seq>cutoff?message:null,unread_count:counts.get(peer)||0,pinned:pref?.pinned===null||pref?.pinned===undefined?!peer:pref.pinned===1,preview_after:cutoff};};
  return {conversations:[row('',group?view(group,ctx):null,'公司工作群'),...[...peers].map(([peer,name])=>row(peer,latest.get(peer)||null,name))].sort((a,b)=>Number(b.pinned)-Number(a.pinned)||(b.message?.created_at||0)-(a.message?.created_at||0)||Number(!!a.peer)-Number(!!b.peer)||a.peer_name.localeCompare(b.peer_name,'zh-CN'))};
 }
 function conversationAction(ctx,body,key,members){
  if(!Array.isArray(members)||typeof body.peer!=='string'||body.peer&&!members.some(m=>m.actor_id===body.peer&&m.can_read!==false))fail('conversation_unavailable',403);
  if(!['pin','clear_preview'].includes(body.action)||body.action==='pin'&&typeof body.pinned!=='boolean')fail('invalid_conversation_action');
  return write(ctx,'conversation.'+body.action,key,body,()=>{
   db.prepare('INSERT OR IGNORE INTO conversation_preferences(actor,peer) VALUES(?,?)').run(ctx.actor_id,body.peer);
   if(body.action==='pin')db.prepare('UPDATE conversation_preferences SET pinned=? WHERE actor=? AND peer=?').run(Number(body.pinned),ctx.actor_id,body.peer);
   else{
    const before=db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM messages').get().seq;
    db.prepare('UPDATE conversation_preferences SET preview_after=? WHERE actor=? AND peer=?').run(before,ctx.actor_id,body.peer);
    // Dismiss old preview badges; do not claim that their text was read.
    const notices=db.prepare(`SELECT n.* FROM notifications n JOIN messages m ON m.id=n.message_id WHERE n.recipient_actor=? AND n.hidden_at IS NULL AND m.seq<=? AND `+(body.peer?`m.message_type='direct' AND EXISTS(SELECT 1 FROM json_each(m.recipients_json) WHERE value=?)`:`m.message_type='chat'`)).all(ctx.actor_id,before,...(body.peer?[body.peer]:[]));
    for(const n of notices){db.prepare("UPDATE notifications SET hidden_at=?,updated_at=?,version=version+1,snapshot_json=json_set(snapshot_json,'$.silent',json('true')) WHERE id=?").run(now(),now(),n.id);noticeChanged(n,true);db.prepare("UPDATE delivery_outbox SET state='expired' WHERE notification_id=? AND id NOT LIKE 'state:%' AND state IN ('queued','sending','failed')").run(n.id);}
   }
   return {state:'updated',peer:body.peer,action:body.action,receipt_id:randomUUID()};
  });
 }
 function publicNotice(r){
  const row=db.prepare('SELECT * FROM messages WHERE id=?').get(r.message_id),meta=decode(row?.metadata_json||'{}');
  const target=notificationTarget(row?.message_type,r.message_id,row?.reply_id,PROJECT);
  const {kind}=target;
  return {...r,...target,priority:meta.priority||'normal',snapshot:decode(r.snapshot_json),
   actor_username:row?.actor_id||'',actor_nickname:row?.display_name||'',change_seq:r.update_version,
   expires_at:meta.expires_at??null,last_urged_at:null,persistent_float:kind==='announcement'&&!r.read_at&&!r.acked_at&&!r.hidden_at&&(!meta.expires_at||meta.expires_at>now()),
   deep_link:target.deep_link};
 }
 function notification(ctx,id){
  read(ctx);const row=db.prepare('SELECT * FROM notifications WHERE id=? AND recipient_actor=?').get(id,ctx.actor_id);
  if(!row)fail('notification_not_found',404);
  const seq=db.prepare('SELECT MAX(seq) n FROM notification_changes WHERE notification_id=? AND recipient_actor=?').get(id,ctx.actor_id).n;
  return {notification:publicNotice({...row,update_version:seq||row.version}),message_badge:messageBadge(ctx)};
 }
 function messageBadge(ctx){read(ctx);const stamp=now();
  const rows=db.prepare("SELECT n.*,n.version AS update_version FROM notifications n JOIN messages m ON m.id=n.message_id WHERE n.recipient_actor=? AND n.read_at IS NULL AND n.acked_at IS NULL AND n.hidden_at IS NULL AND m.message_type IN ('chat','direct','announcement','announcement_reply')").all(ctx.actor_id);
  const version=db.prepare('SELECT COALESCE(MAX(seq),0) n FROM notification_changes WHERE recipient_actor=?').get(ctx.actor_id).n;
  return {count:messageAttention(rows.map(publicNotice),ctx.actor_id,stamp).count,version,computed_at:stamp};
 }
 function notifications(ctx,after=0,limit=100){read(ctx);const n=Math.min(integer(limit,100),200);if(!n)fail('invalid_limit');
  const max=db.prepare('SELECT COALESCE(MAX(seq),0) n FROM notification_changes WHERE recipient_actor=?').get(ctx.actor_id).n;
  const cursor=integer(after,0);if(cursor>max)throw Object.assign(new Error('invalid_after_version'),{code:'validation_failed',hint:'invalid_after_version',status:409});
  const rows=db.prepare('SELECT c.seq AS update_version,n.* FROM notification_changes c JOIN notifications n ON n.id=c.notification_id WHERE c.recipient_actor=? AND c.seq>? ORDER BY c.seq LIMIT ?').all(ctx.actor_id,cursor,n+1);
  const more=rows.length>n,part=rows.slice(0,n),last=part.at(-1)?.update_version??cursor;
  return {message_badge:messageBadge(ctx),notifications:part.map(publicNotice),next_cursor:more?String(last):'',sync_version:more?null:last,has_more:more,
   unread_count:db.prepare('SELECT COUNT(*) n FROM notifications WHERE recipient_actor=? AND read_at IS NULL AND hidden_at IS NULL').get(ctx.actor_id).n};
 }
 function addNotice(actor,row,kind,metadata={}){
  const id=randomUUID(),ts=now();db.prepare('INSERT INTO notifications(id,recipient_actor,message_id,title,summary,snapshot_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
   .run(id,actor,row.id,metadata.title||row.display_name,row.body.slice(0,500),encode({kind,...metadata.snapshot}),ts,ts);
  noticeChanged({id,recipient_actor:actor});db.prepare('INSERT INTO delivery_outbox VALUES(?,?,?,?,?)').run(randomUUID(),id,actor,'queued',ts);return id;
 }
 function publishAnnouncement(ctx,body,key,members){
  if(!ctx.can_publish_announcement)fail('announcement_publish_denied',403);
  const eligible=new Set(members.filter(m=>m.can_read!==false).map(m=>m.actor_id));
  if(typeof body.body!=='string'||!body.body.trim()||body.body.length>20000||typeof body.title!=='string'||!body.title.trim()||body.title.length>120)fail('invalid_announcement');
  if(!['normal','urgent'].includes(body.priority||'normal')||!Array.isArray(body.recipient_usernames)||body.recipient_usernames.some(a=>!eligible.has(a)))fail('invalid_announcement_audience');
  const recipients=[...new Set(body.recipient_usernames)].filter(a=>a!==ctx.actor_id).sort();if(!recipients.length)fail('announcement_recipient_required');
  const expires=body.expires_at??null;if(expires!==null&&(!Number.isSafeInteger(expires)||expires<=now()))fail('invalid_expiration');
  return write(ctx,'announcement.publish',key,{...body,recipient_usernames:recipients},()=>{
   const id=randomUUID(),ts=now(),meta={title:body.title.trim(),priority:body.priority||'normal',expires_at:expires};
   db.prepare("INSERT INTO messages(id,actor_id,display_name,body,mentions,attachments_json,created_at,message_type,recipients_json,metadata_json) VALUES(?,?,?,?,?,?,?,'announcement',?,?)")
    .run(id,ctx.actor_id,ctx.display_name,body.body.trim(),'[]','[]',ts,encode(recipients),encode(meta));
   const row=db.prepare('SELECT * FROM messages WHERE id=?').get(id);for(const actor of recipients)addNotice(actor,row,'announcement',{title:meta.title,snapshot:{silent:false}});
   return {state:'published',announcement_id:id,receipt_id:randomUUID()};
  });
 }
 function announcement(ctx,id){
  get(ctx,id);const r=db.prepare("SELECT * FROM messages WHERE id=? AND message_type='announcement'").get(id);
  if(!r)fail('announcement_not_found',404);
  const meta=decode(r.metadata_json),n=db.prepare('SELECT * FROM notifications WHERE message_id=? AND recipient_actor=? ORDER BY seq LIMIT 1').get(r.id,ctx.actor_id);
  const recipients=[...new Set(decode(r.recipients_json||'[]'))];
  const rows=db.prepare('SELECT recipient_actor,read_at FROM notifications WHERE message_id=? ORDER BY seq').all(r.id);
  const readBy=new Map(rows.map(row=>[row.recipient_actor,row.read_at]));
  const audience=recipients.map(username=>({username,read_at:readBy.get(username)??null}));
  const read_count=audience.filter(person=>person.read_at!==null).length;
  return {id:r.id,...meta,body:r.body,publisher_username:r.actor_id,publisher_name:r.display_name,created_at:r.created_at,notification_id:n?.id??null,read_at:n?.read_at??null,acked_at:n?.acked_at??null,recipient_count:recipients.length,read_count,unread_count:recipients.length-read_count,...(r.actor_id===ctx.actor_id?{audience}:{})};
 }
 function announcements(ctx){read(ctx);return {announcements:db.prepare("SELECT id FROM messages WHERE message_type='announcement' AND (actor_id=? OR EXISTS(SELECT 1 FROM json_each(recipients_json) WHERE value=?)) ORDER BY created_at DESC").all(ctx.actor_id,ctx.actor_id).map(r=>announcement(ctx,r.id))};}
 function announcementReplies(ctx,id,after=0){get(ctx,id);if(db.prepare('SELECT message_type FROM messages WHERE id=?').get(id).message_type!=='announcement')fail('announcement_not_found',404);
  const rows=db.prepare("SELECT * FROM messages WHERE message_type='announcement_reply' AND reply_id=? AND seq>? ORDER BY seq LIMIT 51").all(id,integer(after,0));
  return {replies:rows.slice(0,50).map(r=>({id:r.id,seq:r.seq,body:r.body,author_username:r.actor_id,author_name:r.display_name,created_at:r.created_at})),next_cursor:rows.slice(0,50).at(-1)?.seq??integer(after,0),has_more:rows.length>50};
 }
 function replyAnnouncement(ctx,id,body,key){const parentRow=db.prepare('SELECT * FROM messages WHERE id=?').get(id);get(ctx,id);if(parentRow.message_type!=='announcement')fail('announcement_not_found',404);if(typeof body!=='string'||!body.trim()||body.length>10000)fail('invalid_reply');
  return write(ctx,'announcement.reply',key,{announcement_id:id,body},()=>{const rid=randomUUID(),ts=now(),audience=[...new Set([...decode(parentRow.recipients_json),parentRow.actor_id])];
   db.prepare("INSERT INTO messages(id,actor_id,display_name,body,mentions,reply_id,attachments_json,created_at,message_type,recipients_json) VALUES(?,?,?,?,?,?,?,?,'announcement_reply',?)")
    .run(rid,ctx.actor_id,ctx.display_name,body.trim(),'[]',id,'[]',ts,encode(audience));
   const row=db.prepare('SELECT * FROM messages WHERE id=?').get(rid);for(const actor of audience.filter(a=>a!==ctx.actor_id))addNotice(actor,row,'announcement_reply',{title:'公告回复',snapshot:{announcement_id:id,silent:false}});
   return {state:'published',receipt_id:randomUUID(),reply:{id:rid,seq:row.seq,body:row.body,author_username:ctx.actor_id,author_name:ctx.display_name,created_at:ts}};
  });
 }
 function notificationWake(ctx,id,action){
  read(ctx);const own={actors:[ctx.actor_id]};if(action!=='read')return own;
  const n=db.prepare('SELECT message_id FROM notifications WHERE id=? AND recipient_actor=?').get(id,ctx.actor_id);if(!n)return own;
  const row=db.prepare("SELECT id,actor_id,recipients_json FROM messages WHERE id=? AND message_type='announcement'").get(n.message_id);
  if(!row)return own;
  return {announcement_id:row.id,reader_actor:ctx.actor_id,actors:[...new Set([row.actor_id,...decode(row.recipients_json||'[]')])]};
 }
 function notificationAction(ctx,id,action,body,key){
  if(!['read','ack','hide','pin'].includes(action))fail('unsupported_notification_action');
  const result=write(ctx,'notification.'+action,key,{...body,notification_id:id},()=>{const n=db.prepare('SELECT * FROM notifications WHERE id=? AND recipient_actor=?').get(id,ctx.actor_id);if(!n)fail('notification_not_found',404);
   const col={read:'read_at',ack:'acked_at',hide:'hidden_at',pin:'pinned_at'}[action];
   const stamp=body.off?null:now();
   db.prepare('UPDATE notifications SET '+col+'=?,version=version+1,updated_at=? WHERE id=?').run(stamp,now(),id);noticeChanged(n,action!=='pin');
   return {state:'updated',receipt_id:randomUUID()};});return {...result,message_badge:messageBadge(ctx)};
 }
 return {messageBadge,notification,send,get,change,messages,files,changes,conversations,conversationAction,notifications,notificationAction,notificationWake,publishAnnouncement,announcements,announcement,announcementReplies,replyAnnouncement,profiles:createMemberProfiles(db,{now}),inspirations:createInspirations(db,{read,write,now}),feedback:createFeedbackRepository(db,{read,write,now})};
}

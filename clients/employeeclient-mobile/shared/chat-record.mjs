export const CHAT_RECORD_MIME='application/vnd.employeeclient.chat-record+json';
export const CHAT_RECORD_SCHEMA='employeeclient.chat-record.v1';
export const MAX_RECORD_BYTES=512*1024;
export const MAX_RECORD_FILES=120;
export const isChatRecord=a=>a?.mime===CHAT_RECORD_MIME;
export function validateRecord(value){
 if(!value||value.schema!==CHAT_RECORD_SCHEMA||typeof value.title!=='string'||value.title.length>160||!Array.isArray(value.messages)||!value.messages.length||value.messages.length>20)throw Error('聊天记录格式不可读取');
 let files=0;
 for(const m of value.messages){
  if(!m||typeof m.author!=='string'||m.author.length>160||typeof m.body!=='string'||m.body.length>20000||!Number.isSafeInteger(m.created_at)||m.created_at<0||!Array.isArray(m.attachments)||m.attachments.length>6||(!m.body.trim()&&!m.attachments.length))throw Error('聊天记录内容不可读取');
  for(const a of m.attachments){files++;if(!a||typeof a.id!=='string'||!a.id||a.id.length>160||typeof a.name!=='string'||!a.name||a.name.length>200||typeof a.mime!=='string'||a.mime.length>200||!Number.isSafeInteger(a.size)||a.size<1||a.size>100*1024**3||!/^[a-f0-9]{64}$/.test(a.sha256||'')||a.duration_ms!==undefined&&(!Number.isSafeInteger(a.duration_ms)||a.duration_ms<1))throw Error('聊天记录附件不可读取');}
 }
 if(files>MAX_RECORD_FILES)throw Error('聊天记录附件过多');return value;
}
// Children are resolved by the same authority adapter as top-level attachments.
// The descriptor only retains their IDs; byte metadata stays in the encrypted record.
export async function resolveRecordAttachments(body,resolve){
 const top=await resolve(body);
 if(body.record_attachment_ids===undefined)return top;
 const ids=body.record_attachment_ids;
 if(top.length!==1||!isChatRecord(top[0])||!Array.isArray(ids)||ids.length>MAX_RECORD_FILES||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!id||id.length>160||id===top[0].id))throw Object.assign(Error('chat_record_attachments_invalid'),{code:'chat_record_attachments_invalid',status:400});
 const resolved=[];
 for(let at=0;at<ids.length;at+=6){const rows=await resolve({...body,record_attachment_ids:undefined,attachment_ids:ids.slice(at,at+6)});if(rows.length!==Math.min(6,ids.length-at))throw Error('chat_record_attachments_unresolved');resolved.push(...rows.map(a=>a.id));}
 return [{...top[0],record_attachment_ids:resolved}];
}

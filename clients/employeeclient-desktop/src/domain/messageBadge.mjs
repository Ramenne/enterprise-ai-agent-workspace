import {isRelevantNotice} from './notificationAudience.mjs';
const messageKinds=new Set(['chat_message','announcement','announcement_reply']);
export function isUnreadMessageNotice(n,account='',now=Date.now()){
 return !!n&&messageKinds.has(n.kind)&&!n.read_at&&!n.acked_at&&!n.hidden_at&&!(n.snooze_until>now)&&!(n.expires_at&&n.expires_at<=now)&&isRelevantNotice(n,account)&&!(n.priority!=='urgent'&&(n.silent===true||n.snapshot?.silent===true));
}
export function messageAttention(notes,account='',now=Date.now()){
 const latest=new Map();for(const n of notes||[]){if(!n?.id)continue;const old=latest.get(n.id);if(!old||Number(n.update_version??n.version??0)>=Number(old.update_version??old.version??0))latest.set(n.id,n);}
 const unread=[...latest.values()].filter(n=>isUnreadMessageNotice(n,account,now));
 const chat=unread.filter(n=>n.kind==='chat_message'),announcements=unread.length-chat.length;
 return {count:unread.length,chat:chat.length,announcements,relevant:announcements+chat.filter(n=>['mention','reply'].includes(n.snapshot?.attention)).length};
}
export function validMessageBadge(value){return !!value&&Number.isSafeInteger(value.count)&&value.count>=0&&Number.isSafeInteger(value.version)&&value.version>=0&&Number.isSafeInteger(value.computed_at)&&value.computed_at>=0;}
export function newerMessageBadge(next,previous){return validMessageBadge(next)&&(!validMessageBadge(previous)||next.version>previous.version||next.version===previous.version&&next.computed_at>=previous.computed_at);}

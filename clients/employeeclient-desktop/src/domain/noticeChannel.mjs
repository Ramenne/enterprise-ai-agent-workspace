export const isAnnouncementNotice = note => note.kind === 'announcement' || note.kind === 'announcement_reply';
export const isWorkNotice = note => note.kind !== 'chat_message' && !isAnnouncementNotice(note) && !(note.kind==='hub_update'&&note.snapshot?.silent===true);
export function memberDisplayName(id, members=[], fallback='') {
 const opaque=value=>!value||/^历史(?:公告)?发布(?:者)?$/.test(value)||/^historical-unresolved:/.test(value)||/^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(value);
 const found=members.find(m=>(m.username||m.actor_id)===id);
 for(const name of [found?.nickname,found?.display_name,fallback,id])if(typeof name==='string'&&!opaque(name))return name;
 return String(id||'').startsWith('historical-unresolved:')?'':'成员信息暂缺';
}

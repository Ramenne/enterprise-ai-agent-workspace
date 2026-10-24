// Domain wake events shared by the authenticated event/notification pipeline.
// A wake is a hint, never the source of truth: each consumer still reads its
// own cursor-backed endpoint. Keeping the affected kinds here prevents a chat
// view from refetching history for an unrelated task or announcement event.
export type ChatWake = {
  account: string;
  mode: 'live' | 'catchup';
  kinds: string[];
  announcementIds: string[];
  groupFilesChanged?: boolean;
  conversationPeers?:string[];
};
const listeners = new Set<(event: ChatWake) => void>();
export function onChatWake(listener: (event: ChatWake) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function notifyChatWake(account: string, mode: ChatWake['mode'], arrived: Array<{ kind: string; object_id?: string; snapshot?: Record<string, unknown> }>,hints: {kinds?:readonly string[];announcementIds?:readonly string[];conversationPeers?:readonly string[];groupFilesChanged?:boolean}={}) {
  const kinds = [...new Set([...arrived.map(item => item.kind),...(hints.kinds||[])].filter(Boolean))];
  const announcementIds = [...new Set([...(hints.announcementIds||[]),...arrived.flatMap(item => {
    const id = item.snapshot?.announcement_id ?? (item.kind === 'announcement_reply' ? item.object_id : undefined);
    return typeof id === 'string' && id ? [id] : [];
  })])];
  // A live wake only concerns the two streams that this module exposes. A
  // catch-up wake is deliberately broadcast so a newly visible view can repair
  // its cursor after backgrounding or reconnecting.
  if (mode !== 'catchup' && !kinds.some(kind => kind === 'conversation_list' || kind === 'chat_message' || kind === 'announcement_reply' || kind==='announcement_read' || kind==='hub_update')) return;
  const chatRows=arrived.filter(row=>row.kind==='chat_message');
  const conversationPeers=[...new Set([...(hints.conversationPeers||[]),...chatRows.map(row=>typeof row.snapshot?.conversation_peer==='string'?row.snapshot.conversation_peer:'')])];
  const event = { account, mode, kinds, announcementIds,conversationPeers,groupFilesChanged:hints.groupFilesChanged??(chatRows.length?chatRows.some(row=>row.snapshot?.has_group_files!==false):undefined) };
  for (const listener of listeners) listener(event);
}

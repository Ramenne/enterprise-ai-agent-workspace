import type { ChatMessage } from '@/api/types';
export async function findChatDate(source: {
  messages: () => ChatMessage[]; hasOlder: () => boolean; older: () => Promise<void>;
  error: () => string; valid: () => boolean;
}, day: string): Promise<ChatMessage | null> {
  const start = new Date(day + 'T00:00:00').getTime();
  if (!Number.isFinite(start)) throw Error('请选择有效日期。');
  const tomorrow = new Date(start); tomorrow.setDate(tomorrow.getDate() + 1);
  while (source.valid() && source.hasOlder() && (!source.messages().length || source.messages()[0].created_at >= start)) {
    const before = source.messages()[0]?.seq;
    await source.older();
    if (!source.valid()) return null;
    if (source.error()) throw Error('历史消息加载失败，请重试。');
    if (source.hasOlder() && source.messages()[0]?.seq === before) throw Error('历史消息未能继续加载，请重试。');
  }
  if (!source.valid()) return null;
  return source.messages().find(m => !m.hidden && m.created_at >= start && m.created_at < tomorrow.getTime()) || null;
}

export async function findChatMessage(source: {
  messages: () => ChatMessage[]; hasOlder: () => boolean; older: () => Promise<void>;
  error: () => string; valid: () => boolean;
}, id: string): Promise<ChatMessage | null> {
  while (source.valid()) {
    const found = source.messages().find(message => message.id === id);
    if (found) return found;
    if (!source.hasOlder()) return null;
    const before = source.messages()[0]?.seq;
    await source.older();
    if (!source.valid()) return null;
    if (source.error()) throw Error('原消息加载失败，请重试');
    if (source.hasOlder() && source.messages()[0]?.seq === before) throw Error('历史消息未能继续加载，请重试');
  }
  return null;
}

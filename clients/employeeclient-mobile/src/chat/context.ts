import type { ChatMessage, ChatMessagePage } from '@/api/types';
import {mergeChatMessages} from './projection';

type ContextSource = {
  message: (id: string, signal?: AbortSignal) => Promise<{ message: ChatMessage }>;
  messages: (query: { peer?: string; before?: number; after?: number; limit?: number }, signal?: AbortSignal) => Promise<ChatMessagePage>;
};
export function mergeContextMessages(rows: ChatMessage[]): ChatMessage[] {
  return mergeChatMessages(rows);
}
export function assertContextScope(message: ChatMessage, peer: string) {
  if (!message?.id || !Number.isSafeInteger(message.seq) || (message.conversation_peer || '') !== peer) throw Error('原消息不属于当前会话');
}
function checkTarget(message: ChatMessage, id: string, peer: string) {
  assertContextScope(message, peer);
  if (message.id !== id) throw Error('原消息返回不匹配，请重试');
  if (message.hidden) throw Error('原消息不存在或暂不可见');
  if (message.recalled) throw Error('原消息已撤回');
}
export async function loadChatContext(source: ContextSource, id: string, peer: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const first = (await source.message(id, signal)).message;
  signal.throwIfAborted(); checkTarget(first, id, peer);
  const [older, newer] = await Promise.all([
    source.messages({ peer: peer || undefined, before: first.seq, limit: 25 }, signal),
    source.messages({ peer: peer || undefined, after: first.seq, limit: 25 }, signal),
  ]);
  signal.throwIfAborted();
  // Target may have been hidden/recalled while the two windows were loading.
  const target = (await source.message(id, signal)).message;
  signal.throwIfAborted(); checkTarget(target, id, peer);
  for (const row of [...older.messages, ...newer.messages]) assertContextScope(row, peer);
  if (older.messages.some(row => row.seq >= target.seq) || newer.messages.some(row => row.seq <= target.seq)) throw Error('原消息上下文返回顺序异常，请重试');
  const cursors = [older.sync_cursor, newer.sync_cursor];
  if (cursors.some(value => !Number.isSafeInteger(value) || value! < 0)) throw Error('原消息上下文返回不完整，请重试');
  return { target, messages: mergeContextMessages([...older.messages, target, ...newer.messages]),
    hasOlder: !!older.has_more_old, hasNewer: !!newer.has_more, changeCursor: Math.min(...cursors as number[]) };
}

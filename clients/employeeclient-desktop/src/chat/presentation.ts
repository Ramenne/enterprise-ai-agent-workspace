import type { ChatMessage } from '@/api/types';
import {isChatRecord} from '../../shared/chat-record.mjs';
import { isVoiceMessage } from '@/chat/mediaKind';

// The same content description is used in previews, quotations and the composer.
// It never treats an attachment as delivered before the message receipt exists.
export function messageSnippet(message: Pick<ChatMessage, 'body'> & Partial<Pick<ChatMessage, 'attachments'>>): string {
  if (message.body) return message.body.replace(/\s+/g, ' ').trim();
  return (message.attachments || []).map(attachment => {
    if(isChatRecord(attachment))return '[聊天记录]';
    if (isVoiceMessage(attachment)) return '[语音]';
    if (attachment.mime.startsWith('image/')) return '[图片]';
    if (attachment.mime.startsWith('video/')) return '[视频]';
    return '[文件] ' + attachment.name;
  }).join(' ');
}

export function conversationTime(timestamp: number, now = Date.now()): string {
  const date = new Date(timestamp), today = new Date(now);
  if (!Number.isFinite(date.getTime())) return '';
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const yesterday = new Date(start); yesterday.setDate(yesterday.getDate() - 1);
  if (date >= start && date < new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)) {
    return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
  }
  if (date >= yesterday && date < start) return '昨天';
  // Calendar operations retain local day boundaries across DST changes.
  const week = new Date(start); week.setDate(week.getDate() - ((week.getDay() + 6) % 7));
  if (date >= week && date < start) return '星期' + '日一二三四五六'[date.getDay()];
  return (date.getFullYear() === today.getFullYear() ? '' : date.getFullYear() + '/') + (date.getMonth() + 1) + '/' + date.getDate();
}

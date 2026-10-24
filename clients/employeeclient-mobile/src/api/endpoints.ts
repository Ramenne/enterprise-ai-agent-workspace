import {readAnnouncement,readAnnouncementReplies} from '@/native/announcement-cache';
import {apiRequest} from './client';
import type {NotificationPage,NotificationPriority,Receipt,Announcement,AssigneeOption,DeviceInfo} from './types';
// Current EmployeeClient native business contract; retired Task/Plan/Code APIs removed.
export const me={
// Current authenticated own-device view; no subscription keys returned.
devices:()=>apiRequest<{devices:DeviceInfo[]}>('GET','/business/v1/devices'),
  notifications: (q: { cursor?: string; after_version?: number | null; kind?: string; unread?: string; limit?: number } = {}) =>
    apiRequest<NotificationPage>('GET', '/business/v1/notifications', { query: q as Record<string, string | number | undefined> }),
  notificationAction: (id: string, action: 'read' | 'ack' | 'hide' | 'pin', body: { until?: number; off?: boolean } = {}, idempotencyKey: string) =>
    apiRequest<Receipt>('POST', `/business/v1/notifications/${id}/${action}`, { body, idempotencyKey }),

announcements:()=>apiRequest<{announcements:Announcement[]}>('GET','/business/v1/announcements'),
};
export const communication = {
  conversations:()=>apiRequest<{conversations:Array<{peer:string;peer_name?:string;pinned?:boolean;preview_after?:number;message:import('./types').ChatMessage|null;unread_count:number}>}>('GET','/business/v1/conversations'),
  conversationAction:(body:{peer:string;action:'pin'|'clear_preview';pinned?:boolean},key:string)=>apiRequest<{state:string;peer:string}>('POST','/business/v1/conversations',{body,idempotencyKey:key}),
  announcement:(id:string,changed=false)=>readAnnouncement(id,changed),
  files: (before?: string, signal?: AbortSignal, filter: import('./types').ChatFilter = {}) => apiRequest<{ files: Array<import('./types').ChatAttachment & { message_id?: string; created_at?: number; project_id?: string; work_item_id?: string }>; next_cursor: string | null }>('GET', '/business/v1/files', { query: { ...filter, before, limit: 50 }, signal }),
  members: (signal?: AbortSignal) => apiRequest<{ members: AssigneeOption[] }>('GET', '/business/v1/members', { signal }),
  message: (id: string, signal?: AbortSignal) => apiRequest<{ message: import('./types').ChatMessage }>('GET', `/business/v1/messages/${encodeURIComponent(id)}`, { signal }),
  messages: (query: import('./types').ChatFilter & { peer?: string; author?: string; after?: number; before?: number; limit?: number } = {}, signal?: AbortSignal) =>
    apiRequest<import('./types').ChatMessagePage>('GET', '/business/v1/messages', { query: { ...query }, signal }),
  changes: (after_change: number, signal?: AbortSignal, peer?:string) => apiRequest<import('./types').ChatChangePage>('GET', '/business/v1/messages/changes', { query: { after_change, limit: 100, peer }, signal }),
  changeMessage: (id: string, action: 'hide' | 'recall', idempotencyKey: string, signal?:AbortSignal) => apiRequest<{ message: import('./types').ChatMessage }>('POST', `/business/v1/messages/${encodeURIComponent(id)}/${action}`, { idempotencyKey,signal }),
  send: (body: import('./types').ChatSendBody, idempotencyKey: string,signal?:AbortSignal) =>
    apiRequest<Receipt & { message: import('./types').ChatMessage }>('POST', '/business/v1/messages', { body, idempotencyKey,signal }),
  publishAnnouncement: (body: { title?: string; body: string; priority: NotificationPriority; recipient_usernames: string[]; expires_at?: number | null }, idempotencyKey: string) =>
    apiRequest<Receipt>('POST', '/business/v1/announcements', { body, idempotencyKey }),
  replies: (id:string,after=0,signal?:AbortSignal,changed=false)=>readAnnouncementReplies(id,after,signal,changed),
  reply: (id: string, body: string, idempotencyKey: string) =>
    apiRequest<Receipt & { reply: import('./types').AnnouncementReply }>('POST', `/business/v1/announcements/${encodeURIComponent(id)}/replies`, { body: { body }, idempotencyKey }),
};

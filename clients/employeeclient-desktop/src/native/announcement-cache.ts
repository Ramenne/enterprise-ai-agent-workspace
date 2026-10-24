import {apiRequest,captureApiLease} from '@/api/client';
import {hubCache} from './hub-data';
import {onChatWake} from '@/platform/chatEvents';
import type {AnnouncementReply,Announcement} from '@/api/types';
const replyKeys=new Map<string,Set<string>>();
const key=(id:string)=>'announcement-detail-v1:'+id;
onChatWake(event=>{const lease=captureApiLease();if(event.account!==lease.account)return;for(const id of event.announcementIds||[])if(event.kinds.some(k=>['announcement_read','announcement_reply','announcement'].includes(k))){void hubCache.invalidate(lease,key(id));if(event.kinds.includes('announcement_reply'))void invalidateAnnouncementReplies(id);}});
export function readAnnouncement(id:string,changed=false){const lease=captureApiLease();return hubCache.read(lease,key(id),()=>apiRequest<{announcement:Announcement}>('GET','/business/v1/announcements/'+encodeURIComponent(id)),{force:changed,maxAge:Infinity}) as Promise<{announcement:Announcement}>;}

export async function invalidateAnnouncementReplies(id:string){const lease=captureApiLease();const name=JSON.stringify([lease.account,id]);const keys=new Set([`announcement-replies-v1:${id}:0`,...(replyKeys.get(name)||[])]);await Promise.all([...keys].map(key=>hubCache.invalidate(lease,key)));}
export function readAnnouncementReplies(id:string,after=0,signal?:AbortSignal,changed=false){const lease=captureApiLease(),cacheKey=`announcement-replies-v1:${id}:${after}`,name=JSON.stringify([lease.account,id]);if(!replyKeys.has(name))replyKeys.set(name,new Set());replyKeys.get(name)!.add(cacheKey);return hubCache.read(lease,cacheKey,()=>apiRequest<{replies:AnnouncementReply[];next_cursor:number;has_more:boolean}>('GET','/business/v1/announcements/'+encodeURIComponent(id)+'/replies',{query:{after,limit:50},signal}),{force:changed,maxAge:Infinity}) as Promise<{replies:AnnouncementReply[];next_cursor:number;has_more:boolean}>;}

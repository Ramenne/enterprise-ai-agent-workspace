import {messageAttention} from './messageBadge.mjs';
import type {Notification} from '@/api/types';
export function chatAttention(notes:Notification[]){const result=messageAttention(notes.filter(n=>n.kind==='chat_message'));return {count:result.count,relevant:result.relevant};}

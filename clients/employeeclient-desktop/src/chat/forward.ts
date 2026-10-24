import type {ChatMessage,ChatSendBody} from '@/api/types';
import {captureApiLease} from '@/api/client';
import {communication} from '@/api/endpoints';
import {beginWrite,endWrite,pendingWrite,type PendingWrite} from '@/session/pendingWrites';
import {useChatStore} from '@/store/chat';
import {notifyChatWake} from '@/platform/chatEvents';
export const MAX_FORWARD_MESSAGES=20;
const slot='chat-text-forward';
export type TextForward={peer:string;items:Array<{sourceId:string;text:string}>};
export function canForwardText(message:ChatMessage){return !message.hidden&&!message.recalled&&!!message.body.trim()&&message.body.length<=20000&&!message.attachments.length;}
export function readTextForward(account:string){
  const value=pendingWrite<TextForward>(account,slot,'company');
  if(value&&(typeof value.body.peer!=='string'||!Array.isArray(value.body.items)||!value.body.items.length||value.body.items.length>MAX_FORWARD_MESSAGES||value.body.items.some(item=>typeof item.sourceId!=='string'||typeof item.text!=='string'||!item.text.trim()||item.text.length>20000)))throw Error('转发恢复记录无法读取，已停止发送');
  return value;
}
export function discardTextForward(account:string,key:string){endWrite(account,slot,key);}
export function prepareTextForward(account:string,peer:string,messages:ChatMessage[]):PendingWrite<TextForward>{
  if(readTextForward(account))throw Error('上次转发尚未确认，请先继续原操作');
  const unique=[...new Map(messages.map(message=>[message.id,message])).values()].sort((a,b)=>a.seq-b.seq);
  if(!unique.length||unique.length>MAX_FORWARD_MESSAGES||unique.some(message=>!canForwardText(message)))throw Error('请选择20条以内的文字消息');
  return beginWrite(account,slot,'company',{peer,items:unique.map(message=>({sourceId:message.id,text:message.body}))});
}
export async function sendTextForward(intent:PendingWrite<TextForward>,signal:AbortSignal,progress:(confirmed:number)=>void=()=>{}){
  const lease=captureApiLease(),saved=readTextForward(lease.account);
  if(!saved||saved.key!==intent.key||JSON.stringify(saved.body)!==JSON.stringify(intent.body))throw Error('转发恢复记录已变化，请重新打开');
  if(!Array.isArray(intent.body.items)||!intent.body.items.length||intent.body.items.length>MAX_FORWARD_MESSAGES)throw Error('转发恢复记录无法读取');
  const valid=()=>{if(signal.aborted)throw new DOMException('已暂停','AbortError');if(!lease.valid())throw Error('账号状态已变化，请重新打开转发');};
  let confirmed=0;
  for(const item of intent.body.items){
    valid();
    // No inherited @ recipients, quotation, work association or mutable composer.
    const body:ChatSendBody={body:item.text,mention_usernames:[],attachment_ids:[],project_id:null,work_item_id:null,...(intent.body.peer?{recipient_username:intent.body.peer}:{})};
    const receipt=await communication.send(body,intent.key+'-'+confirmed,signal);valid();
    if(!receipt.message?.id)throw Error('转发结果尚未确认，请按原内容重试');
    useChatStore().acceptSent(lease.account,intent.body.peer,receipt.message);
    notifyChatWake(lease.account,'live',[],{kinds:['chat_message','conversation_list'],conversationPeers:[intent.body.peer]});
    progress(++confirmed);
  }
  valid();endWrite(lease.account,slot,intent.key);
  return confirmed;
}

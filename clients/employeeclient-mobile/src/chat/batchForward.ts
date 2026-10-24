import {isChatRecord} from '../../shared/chat-record.mjs';
import {shallowReactive} from 'vue';
import type {ChatMessage,ChatSendBody} from '@/api/types';
import type {ChatAttachment} from './files';
import {captureApiLease} from '@/api/client';
import {communication} from '@/api/endpoints';
import {beginWrite,endWrite,pendingWrite,updateWrite,type PendingWrite} from '@/session/pendingWrites';
import {canForwardText,MAX_FORWARD_MESSAGES} from './forward';
import {canForwardMedia,readMediaForward,prepareMediaForward,startMediaForward,discardMediaForward,type MediaForwardJob} from './mediaForward';
import {useChatStore} from '@/store/chat';
import {notifyChatWake} from '@/platform/chatEvents';
import {userError} from '@/domain/userError.mjs';
const slot='chat-batch-forward';
export type BatchItem={sourceId:string;text:string;attachment?:ChatAttachment;attachments?:ChatAttachment[]};
export type BatchForward={peer:string;items:BatchItem[];confirmed:number};
export function canForwardMessage(message:ChatMessage){return canForwardText(message)||canForwardMedia(message);}
export function forwardUnavailableReason(message:ChatMessage){
 if(message.hidden||message.recalled)return '所选消息已不可用，请取消选择后重试';
 if(message.body.length>20000)return '所选消息超过20000字，暂时无法转发';
 return '所选消息含不可读取的附件或空内容，请取消选择该条消息';
}

export function readBatchForward(account:string){
 const value=pendingWrite<BatchForward>(account,slot,'company');
 if(value&&(typeof value.key!=='string'||typeof value.body.peer!=='string'||!Array.isArray(value.body.items)||!value.body.items.length||value.body.items.length>MAX_FORWARD_MESSAGES||
  !Number.isSafeInteger(value.body.confirmed)||value.body.confirmed<0||value.body.confirmed>value.body.items.length||
  new Set(value.body.items.map(i=>i?.sourceId)).size!==value.body.items.length||value.body.items.some(i=>!i||typeof i.sourceId!=='string'||!i.sourceId||typeof i.text!=='string'||i.text.length>20000||i.attachments!==undefined&&(!i.attachment||!Array.isArray(i.attachments)||JSON.stringify(i.attachment)!==JSON.stringify(i.attachments[0]))||
   (i.attachment?!canForwardMedia({id:i.sourceId,body:i.text,attachments:i.attachments||[i.attachment]}):!i.text.trim()))))throw Error('批量转发恢复记录无法读取，已停止发送');
 return value;
}
export function prepareBatchForward(account:string,peer:string,messages:ChatMessage[]){
 if(readBatchForward(account)||readMediaForward(account,'batch'))throw Error('上次批量转发尚未确认，请先继续原操作');
 const rows=[...new Map(messages.map(m=>[m.id,m])).values()].sort((a,b)=>a.seq-b.seq);
 if(!rows.length||rows.length>MAX_FORWARD_MESSAGES||rows.some(m=>!canForwardMessage(m)))throw Error('请选择20条以内的文字、图片、视频、语音或文件消息');
 return beginWrite<BatchForward>(account,slot,'company',{peer,items:rows.map(m=>({sourceId:m.id,text:m.body,...(m.attachments.length?{attachment:m.attachments[0],...(m.attachments.length>1?{attachments:m.attachments}:{})}:{})})),confirmed:0});
}
export type BatchForwardJob={account:string;key:string;state:'running'|'paused'|'error'|'complete';confirmed:number;total:number;current?:MediaForwardJob;error?:string;promise:Promise<number|false>;cancel:()=>void};
const jobs=shallowReactive(new Map<string,BatchForwardJob>()),identity=(account:string,key:string)=>JSON.stringify([account,key]);
export function getBatchForward(account:string,key:string){return jobs.get(identity(account,key));}
export function pauseBatchForward(account:string){for(const job of jobs.values())if(job.account===account&&job.state==='running')job.cancel();}
function clearPreviousChild(account:string,operation:PendingWrite<BatchForward>){
 const child=readMediaForward(account,'batch');if(!child)return;
 const prefix=operation.key+'-',index=child.key.startsWith(prefix)?Number(child.key.slice(prefix.length)):NaN;
 if(!Number.isSafeInteger(index)||index<0||index>=operation.body.confirmed)throw Error('批量文件转发记录不匹配，请继续原操作');
 discardMediaForward(account,child.key,'batch');
}
export function discardBatchForward(account:string,key:string){
 if(getBatchForward(account,key)?.state==='running')throw Error('请先暂停批量转发');
 const child=readMediaForward(account,'batch');
 if(child){if(!child.key.startsWith(key+'-'))throw Error('文件转发记录不匹配');discardMediaForward(account,child.key,'batch');}
 endWrite(account,slot,key);jobs.delete(identity(account,key));
}
export function startBatchForward(intent:PendingWrite<BatchForward>):BatchForwardJob{
 const lease=captureApiLease(),saved=readBatchForward(lease.account);
 if(!lease.valid()||!saved||saved.key!==intent.key||JSON.stringify(saved.body)!==JSON.stringify(intent.body))throw Error('批量转发记录或账号状态已变化，请重新打开');
 const prior=getBatchForward(lease.account,intent.key);if(prior?.state==='running')return prior;
 const operation=JSON.parse(JSON.stringify(saved)) as PendingWrite<BatchForward>,controller=new AbortController();
 const job=shallowReactive<BatchForwardJob>({account:lease.account,key:saved.key,state:'running',confirmed:saved.body.confirmed,total:saved.body.items.length,promise:undefined!,cancel:()=>{controller.abort();job.current?.cancel();job.state='paused';}});
 const check=()=>{if(controller.signal.aborted||!lease.valid())throw new DOMException('批量转发已暂停','AbortError');const current=readBatchForward(lease.account);if(!current||current.key!==operation.key||JSON.stringify(current.body)!==JSON.stringify(operation.body))throw Error('批量转发记录已变化');};
 jobs.set(identity(lease.account,saved.key),job);
 job.promise=(async()=>{
  try{
   check();const {peer,items}=operation.body;
   // An already-advanced parent may retain the preceding child if a process
   // stopped before cleanup. Only this parent's confirmed child can be cleared.
   const existing=readMediaForward(lease.account,'batch');
   if(existing&&existing.key!==operation.key+'-'+operation.body.confirmed)clearPreviousChild(lease.account,operation);
   for(let index=operation.body.confirmed;index<items.length;index++){
    check();const item=items[index],childKey=operation.key+'-'+index;
    if(item.attachment&&(item.attachments||[item.attachment]).some(isChatRecord)){
     const merged=await import('./mergedForward');
     let child=merged.readMergedForward(lease.account);
     if(child&&child.key!==childKey+'-record-child')throw Error('请先处理另一次聊天记录转发');
     child ||=merged.prepareMergedForward(lease.account,peer,[{id:item.sourceId,seq:index,author_name:'成员',author_username:lease.account,created_at:0,body:item.text,attachments:item.attachments||[item.attachment],mention_usernames:[],reply_to:null}],childKey+'-record-child');
     const nested=merged.startMergedForward(child);const abort=()=>nested.cancel();controller.signal.addEventListener('abort',abort,{once:true});
     try{if(await nested.promise===false)throw Error(nested.error||'聊天记录转发未完成');}finally{controller.signal.removeEventListener('abort',abort);}check();
    }else if(item.attachment){
     let child=readMediaForward(lease.account,'batch');
     if(child&&(child.key!==childKey||child.body.peer!==peer||child.body.sourceId!==item.sourceId||child.body.caption!==item.text||JSON.stringify(child.body.attachment)!==JSON.stringify(item.attachment)||child&&JSON.stringify(child.body.attachments)!==JSON.stringify(item.attachments)))throw Error('批量文件转发记录不匹配');
     child ||=prepareMediaForward(lease.account,peer,{id:item.sourceId,body:item.text,attachments:item.attachments||[item.attachment]},{key:childKey});
     check();job.current=startMediaForward(child,'batch');
     if(!await job.current.promise)throw Error(job.current.error||'文件转发尚未确认，请继续原操作');
     check();
    }else{
     if(readMediaForward(lease.account,'batch'))throw Error('待确认文件记录不匹配');
     const body:ChatSendBody={body:item.text,mention_usernames:[],attachment_ids:[],project_id:null,work_item_id:null,...(peer?{recipient_username:peer}:{})};
     const receipt=await communication.send(body,childKey+'-message',controller.signal);check();
     if(!receipt.message?.id||receipt.message.author_username!==lease.account||(receipt.message.conversation_peer||'')!==peer||receipt.message.body!==item.text||receipt.message.attachments.length)throw Error('文字转发结果尚未确认，请继续原操作');
     useChatStore().acceptSent(lease.account,peer,receipt.message);
     notifyChatWake(lease.account,'live',[],{kinds:['chat_message','conversation_list'],conversationPeers:[peer]});
    }
    // Advance durably before removing the child's protocol/copy receipt. On
    // quota/termination failure retry still has the same key and frozen choice.
    check();const next={...operation.body,confirmed:index+1};updateWrite(lease.account,slot,operation.key,next);operation.body=next;job.confirmed=index+1;
    if(item.attachment&&!(item.attachments||[item.attachment]).some(isChatRecord))discardMediaForward(lease.account,childKey,'batch');
    job.current=undefined;
   }
   check();endWrite(lease.account,slot,operation.key);job.state='complete';return items.length;
  }catch(e){job.state=controller.signal.aborted||!lease.valid()?'paused':'error';job.error=userError(e,'转发未完成，原操作已保留，请重试');return false;}
  finally{for(const [key,value] of jobs)if(value!==job&&value.state!=='running')jobs.delete(key);}
 })();return job;
}

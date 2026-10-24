import {shallowReactive} from 'vue';
import type {ChatMessage} from '@/api/types';
import {captureApiLease} from '@/api/client';
import {communication} from '@/api/endpoints';
import {beginWrite,endWrite,pendingWrite,updateWrite,type PendingWrite} from '@/session/pendingWrites';
import {useChatStore} from '@/store/chat';
import {notifyChatWake} from '@/platform/chatEvents';
import {userError} from '@/domain/userError.mjs';
const slot='chat-batch-delete';
export const MAX_SELECTED_MESSAGES=20;
export function canSelectMessage(message:ChatMessage){return !message.hidden&&!message.recalled;}
export function canDeleteMessage(message:ChatMessage){return canSelectMessage(message)&&!!message.allowed_actions?.includes('hide');}
export function selectionText(messages:ChatMessage[]){
 const rows=[...new Map(messages.map(m=>[m.id,m])).values()].sort((a,b)=>a.seq-b.seq);
 if(!rows.length||rows.some(m=>!canSelectMessage(m)||!m.body))throw Error('所选消息需要都有文字内容');
 return rows.map(m=>m.body).join('\n\n');
}
export type BatchDelete={peer:string;ids:string[];confirmed:number};
export function readBatchDelete(account:string){
 const value=pendingWrite<BatchDelete>(account,slot,'company');
 if(value&&(typeof value.key!=='string'||!value.body||typeof value.body.peer!=='string'||value.body.peer.length>128||!Array.isArray(value.body.ids)||!value.body.ids.length||value.body.ids.length>MAX_SELECTED_MESSAGES||new Set(value.body.ids).size!==value.body.ids.length||value.body.ids.some(id=>typeof id!=='string'||!id||id.length>128)||!Number.isSafeInteger(value.body.confirmed)||value.body.confirmed<0||value.body.confirmed>value.body.ids.length))throw Error('批量删除恢复记录无法读取，已停止操作');
 return value;
}
export function prepareBatchDelete(account:string,peer:string,messages:ChatMessage[]){
 if(readBatchDelete(account))throw Error('上次批量删除尚未确认，请先继续原操作');
 if(useChatStore().mutationPending)throw Error('请先确认上一次消息操作的结果');
 const rows=[...new Map(messages.map(m=>[m.id,m])).values()].sort((a,b)=>a.seq-b.seq);
 if(!rows.length||rows.length>MAX_SELECTED_MESSAGES||rows.some(m=>!canDeleteMessage(m)))throw Error('请选择20条以内可删除的消息');
 if(rows.some(m=>(m.conversation_peer||'')!==peer))throw Error('所选消息不属于同一会话');
 return beginWrite<BatchDelete>(account,slot,'company',{peer,ids:rows.map(m=>m.id),confirmed:0});
}
export type BatchDeleteJob={account:string;key:string;confirmed:number;total:number;state:'running'|'paused'|'error'|'complete';error?:string;promise:Promise<number|false>;cancel:()=>void};
const jobs=shallowReactive(new Map<string,BatchDeleteJob>()),identity=(account:string,key:string)=>JSON.stringify([account,key]);
export function getBatchDelete(account:string,key:string){return jobs.get(identity(account,key));}
export function pauseBatchDelete(account:string){for(const job of jobs.values())if(job.account===account&&job.state==='running')job.cancel();}
export function discardBatchDelete(account:string,key:string){if(getBatchDelete(account,key)?.state==='running')throw Error('请先暂停删除');endWrite(account,slot,key);jobs.delete(identity(account,key));}
export function startBatchDelete(intent:PendingWrite<BatchDelete>){
 const lease=captureApiLease(),saved=readBatchDelete(lease.account);
 if(!lease.valid()||!saved||saved.key!==intent.key||JSON.stringify(saved.body)!==JSON.stringify(intent.body))throw Error('删除记录或账号状态已变化，请重新打开');
 if(useChatStore().mutationPending)throw Error('请先确认上一次消息操作的结果');
 const prior=getBatchDelete(lease.account,intent.key);if(prior?.state==='running')return prior;
 const operation=JSON.parse(JSON.stringify(saved)) as PendingWrite<BatchDelete>,controller=new AbortController();
 const job=shallowReactive<BatchDeleteJob>({account:lease.account,key:saved.key,confirmed:saved.body.confirmed,total:saved.body.ids.length,state:'running',promise:undefined!,cancel:()=>{controller.abort();job.state='paused';}});
 const check=()=>{if(controller.signal.aborted||!lease.valid())throw new DOMException('批量删除已暂停','AbortError');const current=readBatchDelete(lease.account);if(!current||current.key!==operation.key||JSON.stringify(current.body)!==JSON.stringify(operation.body))throw Error('删除记录已变化');};
 jobs.set(identity(lease.account,saved.key),job);
 job.promise=(async()=>{
  try{
   for(let i=operation.body.confirmed;i<operation.body.ids.length;i++){
    check();const id=operation.body.ids[i],receipt=await communication.changeMessage(id,'hide',operation.key+'-'+i,controller.signal);check();
    if(receipt.message?.id!==id||!receipt.message.hidden||(receipt.message.conversation_peer||'')!==operation.body.peer)throw Error('删除结果尚未确认，请继续原操作');
    useChatStore().acceptChange(lease.account,operation.body.peer,receipt.message);
    notifyChatWake(lease.account,'live',[],{kinds:['chat_message','conversation_list'],conversationPeers:[operation.body.peer]});
    const next={...operation.body,confirmed:i+1};updateWrite(lease.account,slot,operation.key,next);operation.body=next;job.confirmed=i+1;
   }
   check();endWrite(lease.account,slot,operation.key);job.state='complete';return job.total;
  }catch(e){job.state=controller.signal.aborted||!lease.valid()?'paused':'error';job.error=userError(e,'删除尚未完成，请继续原操作');return false;}
  finally{for(const [key,value] of jobs)if(value!==job&&value.state!=='running')jobs.delete(key);}
 })();return job;
}

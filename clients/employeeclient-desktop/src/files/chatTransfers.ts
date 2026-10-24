import {canSendSmallMedia,sendSmallMedia} from './smallMedia';
import {prepareTransfer,putTransfer,readTransfers,removeTransfer,restoredTransferSource,verifyTransferSource,transferIdentity,type TransferRecord} from './transferJournal';
import {userError} from '@/domain/userError.mjs';
import {shallowReactive} from 'vue';
import {captureApiLease} from '@/api/client';
import {communication} from '@/api/endpoints';
import {uploadChatFile,type UploadFile,type ChatAttachment} from '@/chat/files';
import type {ChatSendBody,ChatMessage} from '@/api/types';
import type {TransferProgress} from './transferProgress';
import {effectiveMime} from './fileType';
import {useChatStore} from '@/store/chat';
import {notifyChatWake} from '@/platform/chatEvents';
export type ChatTransfer={key:string;account:string;peer:string;name:string;mime:string;size:number;purpose:'file'|'voice';duration?:number;url?:string;state:'running'|'error'|'complete'|'cancelled';stage:string;progress?:TransferProgress;error?:string;attachment?:ChatAttachment;messageId?:string;needsSource:boolean;needsConfirmation:boolean;receiptPending:boolean;promise:Promise<boolean>;retry:()=>Promise<boolean>;resumeWith:(file:UploadFile)=>Promise<boolean>;discard:()=>Promise<boolean>;cancel:()=>void;releaseSource:()=>void};
const jobs=shallowReactive(new Map<string,ChatTransfer>());
const restores=new Map<string,Promise<void>>();
export function chatTransfers(account:string,peer:string){return [...jobs.values()].filter(j=>j.account===account&&j.peer===peer);}
function createJob(account:string,peer:string,key:string,message:ChatSendBody,purpose:'file'|'voice',duration:number|undefined,source:UploadFile|undefined,record?:TransferRecord,autoSend=true):ChatTransfer{
 const identity=transferIdentity(account,peer,key),meta=record?.file||source!;
 let controller=new AbortController(),generation=0,smallMedia=record?.smallMedia;
 let confirmed: {message:ChatMessage}|undefined=record?.receipt?{message:record.receipt}:undefined;
 let sourceVerified=!record,discarding=false;
 let sendConfirmed=record?record.sendConfirmed!==false:autoSend;
 const frozen=JSON.parse(JSON.stringify(message));
 const job=shallowReactive<ChatTransfer>({key:identity,account,peer,purpose,duration,name:meta.name,mime:effectiveMime(meta.name,meta.type),size:meta.size,url:source instanceof Blob&&/^(image|video)\//.test(effectiveMime(meta.name,meta.type))?URL.createObjectURL(source):undefined,state:record?.state==='complete'?'complete':record?'cancelled':'running',stage:record?.state==='complete'?'已发送':record?'上次传输已保留，请重试':'正在准备文件…',attachment:record?.attachment,messageId:record?.receipt?.id,needsSource:!source&&!record?.attachment&&!confirmed,needsConfirmation:!sendConfirmed,receiptPending:!!record?.receiptPending&&!confirmed,promise:Promise.resolve(false),retry:undefined!,resumeWith:undefined!,discard:undefined!,releaseSource:()=>source?.release?.(),cancel:()=>{if(job.state==='complete')return;controller.abort();job.state='cancelled';job.stage=job.receiptPending?'发送结果待确认':job.needsConfirmation?'选择已保留，尚未发送':'已暂停';}});
 const run=async(prepareOnly=false)=>{
  job.state='running';job.error=undefined;const request=controller=new AbortController(),turn=++generation,lease=captureApiLease();
  const check=()=>{if(lease.account!==account||!lease.valid()||request.signal.aborted||turn!==generation||jobs.get(identity)!==job)throw new DOMException('传输已暂停','AbortError');};
  try{
   check();const sendingBody={...frozen,...(peer?{recipient_username:peer}:{})};
   if(!record){
    if(!source)throw Error('请选择原文件继续');smallMedia??=canSendSmallMedia(source,sendingBody,peer,purpose,duration);
    job.stage='正在保留待发恢复记录…';const prepared=await prepareTransfer(account,peer,key,frozen,source,purpose,duration,smallMedia,check,loaded=>{check();job.progress={phase:'hash',loaded,total:meta.size};});check();record={...prepared,sendConfirmed};
    const restored=restoredTransferSource(record);if(restored){source?.release?.();source=restored;}
   }
   // Persist before every attempt. A failed local write never permits untracked sending.
   if(!prepareOnly){sendConfirmed=true;job.needsConfirmation=false;}
   record={...record,sendConfirmed};await putTransfer({...record,state:'pending'});check();
   if(prepareOnly){job.state='cancelled';job.stage='文件已选好，确认后发送';job.progress=undefined;return false;}
   if(source&&!sourceVerified&&!job.attachment&&!confirmed){const verified=await verifyTransferSource(record,source,check);check();source=verified;sourceVerified=true;}
   if(!source&&!job.attachment&&!confirmed){job.needsSource=true;throw Error('应用重启后需要重新选择原文件继续，接收方和原发送编号已保留');}
   const awaitReceipt=async()=>{if(job.receiptPending)return;const next={...record!,receiptPending:true};await putTransfer(next);check();record=next;job.receiptPending=true;};
   if(smallMedia&&!confirmed){await awaitReceipt();const receipt=await sendSmallMedia(source!,sendingBody,peer,purpose,duration,key+'-message',request.signal,(stage,progress)=>{check();job.stage=stage;job.progress=progress;});check();confirmed=receipt;job.attachment=confirmed.message.attachments[0];}
   const commit=peer?{body:{...frozen,recipient_username:peer},key:key+'-message',onReceipt:(message:ChatMessage)=>{check();confirmed={message};}}:undefined;
   if(peer&&!job.attachment&&!confirmed)await awaitReceipt();
   check();const attachment=job.attachment||confirmed?.message.attachments[0]||await uploadChatFile(source!,key,(stage,progress)=>{check();job.stage=stage;job.progress=progress;},request.signal,purpose,duration,peer,commit);check();job.attachment=attachment;job.needsSource=false;
   record={...record,attachment:job.attachment,receipt:confirmed?.message,...(confirmed?{receiptPending:false}:{})};await putTransfer(record);check();
   job.stage='正在发送…';job.progress=undefined;
   const body={...frozen,attachment_ids:[job.attachment.id],...(peer?{recipient_username:peer}:{})};
   if(!confirmed)await awaitReceipt();
   const sent=confirmed||await communication.send(body,key+'-message',request.signal);check();confirmed=sent;
   if(!confirmed.message?.attachments.some(a=>a.id===job.attachment!.id))throw Error('发送回执未包含文件，请重试核对');
   record={...record,receipt:confirmed.message,receiptPending:false,state:'complete'};await putTransfer(record);check();
   source?.release?.();job.messageId=confirmed.message.id;useChatStore().acceptSent(account,peer,confirmed.message);job.receiptPending=false;job.state='complete';job.stage='已发送';
   notifyChatWake(account,'live',[],{kinds:['chat_message','conversation_list'],conversationPeers:[peer],groupFilesChanged:!peer});return true;
  }catch(error){
   if(turn!==generation||jobs.get(identity)!==job)return false;
   job.state=request.signal.aborted||lease.account!==account||!lease.valid()?'cancelled':'error';job.error=userError(error,'发送未完成，内容已保留，请重试');job.stage=job.receiptPending?'发送结果待确认':job.state==='cancelled'?'已暂停':'发送未完成';job.progress=undefined;
   if(record)try{await putTransfer({...record,state:job.state==='cancelled'?'paused':'error'});}catch{if(turn===generation&&jobs.get(identity)===job)job.error+='；本机恢复记录未能保存，请保持当前页面';}
   return false;
  }
 };
 job.retry=()=>{if(discarding)return Promise.resolve(false);const lease=captureApiLease();if(lease.account!==account||!lease.valid()){if(job.state!=='complete'){job.state='cancelled';job.stage='已暂停';}return Promise.resolve(false);}if(job.state==='running'||job.state==='complete')return job.promise;job.promise=run();return job.promise;};
 job.resumeWith=(file)=>{
  if(discarding||job.state==='running'||job.state==='complete'||!record)return Promise.resolve(false);
  const lease=captureApiLease(),turn=++generation,request=controller=new AbortController();
  const check=()=>{if(lease.account!==account||!lease.valid()||request.signal.aborted||turn!==generation||jobs.get(identity)!==job)throw new DOMException('传输已暂停','AbortError');};
  job.state='running';job.stage='正在核对原文件…';job.error=undefined;
  const work=(async()=>{
   try{check();const verified=await verifyTransferSource(record!,file,check);check();source=verified;sourceVerified=true;job.needsSource=false;job.state='cancelled';if(!sendConfirmed){job.stage='文件已选好，确认后发送';return true;}return await job.retry();}
   catch(error){if(turn===generation){job.state=request.signal.aborted||!lease.valid()||lease.account!==account?'cancelled':'error';job.stage=job.state==='cancelled'?'已暂停':'原文件尚未确认';job.error=userError(error,'原文件尚未确认');}return false;}
  })();job.promise=work;return work;
 };
 job.discard=async()=>{if(discarding||!job.needsConfirmation||job.state==='running'||jobs.get(identity)!==job)return false;const lease=captureApiLease();if(lease.account!==account||!lease.valid())return false;discarding=true;try{if(record)await removeTransfer(identity);if(jobs.get(identity)!==job)return false;controller.abort();generation++;jobs.delete(identity);source?.release?.();if(job.url)URL.revokeObjectURL(job.url);return true;}catch(error){job.error=userError(error,'取消未完成，请重试');return false;}finally{discarding=false;}};
 jobs.set(identity,job);if(!record)job.promise=run(!autoSend);else {if(job.receiptPending)job.stage='发送结果待确认';else if(!sendConfirmed)job.stage='文件已选好，确认后发送';job.promise=Promise.resolve(record.state==='complete');}return job;
}
export function startChatTransfer(file:UploadFile,key:string,peer:string,message:ChatSendBody,purpose:'file'|'voice',duration?:number):ChatTransfer{
 const lease=captureApiLease(),identity=transferIdentity(lease.account,peer,key),previous=jobs.get(identity);if(previous)return previous;
 return createJob(lease.account,peer,key,message,purpose,duration,file);
}
export function stageChatTransfer(file:UploadFile,key:string,peer:string,message:ChatSendBody):ChatTransfer{
 const lease=captureApiLease(),identity=transferIdentity(lease.account,peer,key),previous=jobs.get(identity);if(previous)return previous;
 return createJob(lease.account,peer,key,message,'file',undefined,file,undefined,false);
}
export async function restoreChatTransfers(account:string,peer:string){
 const scope=JSON.stringify([account,peer]),previous=restores.get(scope);if(previous)return previous;
 const lease=captureApiLease();if(lease.account!==account||!lease.valid())return;
 const work=(async()=>{for(const record of await readTransfers(account,peer)){
  if(!lease.valid()||lease.account!==account)return;if(jobs.has(record.id))continue;
  const job=createJob(account,peer,record.requestKey,record.message,record.purpose,record.duration,restoredTransferSource(record),record);
  if(record.receipt)useChatStore().acceptSent(account,peer,record.receipt);
  if(job.needsSource)job.stage=job.needsConfirmation?'选择已保留，请重选原文件后确认发送':'待发内容已保留，请选择原文件继续';
 }})();restores.set(scope,work);try{await work;}finally{if(restores.get(scope)===work)restores.delete(scope);}
}
export function clearChatTransfers(account:string){for(const [key,job] of jobs)if(job.account===account){job.cancel();job.releaseSource();if(job.url)URL.revokeObjectURL(job.url);jobs.delete(key);}}
export function pruneChatTransfers(account:string,ids:string[]){for(const [key,job] of jobs)if(job.account===account&&job.state==='complete'&&job.messageId&&ids.includes(job.messageId)){if(job.url)URL.revokeObjectURL(job.url);jobs.delete(key);void removeTransfer(key).catch(()=>{});}}

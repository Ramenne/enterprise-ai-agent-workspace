import {shallowReactive} from 'vue';
import {captureApiLease} from '@/api/client';
import {communication} from '@/api/endpoints';
import {beginWrite,endWrite,pendingWrite,updateWrite,type PendingWrite} from '@/session/pendingWrites';
import {getChatDownload,uploadChatFile,type ChatAttachment} from './files';
import type {ChatMessage,ChatSendBody} from '@/api/types';
import {isVoiceMessage} from './mediaKind';
import {effectiveKind,effectiveMime} from '@/files/fileType';
import {findAttachment,type Attachment,type LoadedMedia} from '@/collaboration/media';
import {getAcquisition,startAcquisition} from '@/files/acquisition';
import {canSendSmallMedia,sendSmallMedia} from '@/files/smallMedia';
import {useChatStore} from '@/store/chat';
import {notifyChatWake} from '@/platform/chatEvents';
import {userError} from '@/domain/userError.mjs';
import type {TransferProgress} from '@/files/transferProgress';
import {fileDigest} from '@/files/uploadReceipts';
type MediaChannel='single'|'batch';
const slots={single:'chat-media-forward',batch:'chat-batch-media-forward'};
type SourceMessage=Pick<ChatMessage,'id'|'body'|'attachments'|'hidden'|'recalled'>;
export type MediaForward={peer:string;sourceId:string;caption:string;attachment:ChatAttachment;smallMedia?:boolean;prepared?:ChatAttachment;attachments?:ChatAttachment[];preparedItems?:ChatAttachment[]};
function validAttachment(a:ChatAttachment){return !!a&&typeof a.id==='string'&&!!a.id&&typeof a.name==='string'&&!!a.name&&a.name.length<=200&&typeof a.mime==='string'&&a.mime.length<=200&&Number.isSafeInteger(a.size)&&a.size>0&&a.size<=100*1024**3&&/^[a-f0-9]{64}$/.test(a.sha256)&&!a.source_unavailable&&(!isVoiceMessage(a)||a.mime.startsWith('audio/'))&&(a.duration_ms===undefined||Number.isSafeInteger(a.duration_ms)&&a.duration_ms>0);}
function matchesTarget(a:ChatAttachment,source:ChatAttachment,peer:string,account:string){return isVoiceMessage(a)===isVoiceMessage(source)&&(!isVoiceMessage(source)||a.duration_ms===source.duration_ms)&&a.sha256===source.sha256&&a.size===source.size&&a.name===source.name&&effectiveMime(a.name,a.mime)===effectiveMime(source.name,source.mime)&&(peer?a.id.startsWith('private:')&&a.private_peer===peer&&a.owner_username===account:!a.id.startsWith('private:'));}
export function canForwardMedia(message:SourceMessage){return !message.hidden&&!message.recalled&&message.body.length<=20000&&message.attachments.length>0&&message.attachments.length<=6&&message.attachments.every(validAttachment);}
export function readMediaForward(account:string,channel:MediaChannel='single'){
 const value=pendingWrite<MediaForward>(account,slots[channel],'company');
 if(value&&(typeof value.body.peer!=='string'||typeof value.body.sourceId!=='string'||typeof value.body.caption!=='string'||value.body.caption.length>20000||!validAttachment(value.body.attachment)||value.body.smallMedia!==undefined&&typeof value.body.smallMedia!=='boolean'||value.body.prepared&&!validAttachment(value.body.prepared)||value.body.attachments!==undefined&&(!Array.isArray(value.body.attachments)||value.body.attachments.length<2||value.body.attachments.length>6||!value.body.attachments.every(validAttachment)||JSON.stringify(value.body.attachments[0])!==JSON.stringify(value.body.attachment))||value.body.preparedItems!==undefined&&(!value.body.attachments||!Array.isArray(value.body.preparedItems)||value.body.preparedItems.length>value.body.attachments.length||!value.body.preparedItems.every(validAttachment))))throw Error('文件转发恢复记录无法读取，已停止发送');
 return value;
}
export function prepareMediaForward(account:string,peer:string,message:SourceMessage,batch?:{key:string}):PendingWrite<MediaForward>{
 const channel=batch?'batch':'single';
 if(readMediaForward(account,channel))throw Error('上次文件转发尚未确认，请先继续原操作');
 if(!canForwardMedia(message))throw Error('请选择可读取的图片、视频、语音或文件消息');
 return beginWrite(account,slots[channel],'company',{peer,sourceId:message.id,caption:message.body,attachment:message.attachments[0],...(message.attachments.length>1?{attachments:message.attachments}:{})},batch?.key);
}
export type MediaForwardJob={account:string;key:string;peer:string;state:'running'|'error'|'paused'|'complete';stage:string;progress?:TransferProgress;error?:string;messageId?:string;promise:Promise<boolean>;cancel:()=>void};
const jobs=shallowReactive(new Map<string,MediaForwardJob>());
export function getMediaForward(account:string,key:string,channel:MediaChannel='single'){return jobs.get(JSON.stringify([account,channel,key]));}
export function pauseMediaForward(account:string){for(const job of jobs.values())if(job.account===account&&job.state==='running')job.cancel();}
export function discardMediaForward(account:string,key:string,channel:MediaChannel='single'){if(getMediaForward(account,key,channel)?.state==='running')throw Error('请先暂停文件转发');endWrite(account,slots[channel],key);jobs.delete(JSON.stringify([account,channel,key]));}
export function startMediaForward(intent:PendingWrite<MediaForward>,channel:MediaChannel='single'):MediaForwardJob{
 const slot=slots[channel],lease=captureApiLease(),saved=readMediaForward(lease.account,channel);
 if(!lease.valid()||!saved||saved.key!==intent.key||JSON.stringify(saved.body)!==JSON.stringify(intent.body))throw Error('文件转发记录或账号状态已变化，请重新打开');
 const identity=JSON.stringify([lease.account,channel,intent.key]),prior=jobs.get(identity);if(prior?.state==='running'||channel==='batch'&&prior?.state==='complete')return prior;
 const controller=new AbortController(),operation=JSON.parse(JSON.stringify(saved)) as PendingWrite<MediaForward>;
 const check=()=>{if(controller.signal.aborted||!lease.valid())throw new DOMException('转发已暂停','AbortError');const current=readMediaForward(lease.account,channel);if(!current||current.key!==operation.key||JSON.stringify(current.body)!==JSON.stringify(operation.body))throw Error('文件转发记录已变化');};
 const job=shallowReactive<MediaForwardJob>({account:lease.account,key:operation.key,peer:operation.body.peer,state:'running',stage:'正在准备文件…',promise:undefined!,cancel:()=>{controller.abort();job.state='paused';job.stage='已暂停';}});
 jobs.set(identity,job);
 job.promise=(async()=>{
  let media:LoadedMedia|undefined;
  try{
   check();
   if(operation.body.attachments){
    const sources=operation.body.attachments,peer=operation.body.peer,prepared=[...(operation.body.preparedItems||[])];
    const context={account:lease.account,computer:'cloud',provider:'company',thread:'group'};
    for(let index=0;index<sources.length;index++){
     const source=sources[index];check();
     if(prepared[index]){if(!matchesTarget(prepared[index],source,peer,lease.account))throw Error('目标文件回执不匹配');continue;}
     const item:Attachment={...source,mime:effectiveMime(source.name,source.mime),kind:effectiveKind(source.name,source.mime),version:`${source.ver}:${source.sha256}`,groupAttachment:source,resolveUrl:async signal=>(await getChatDownload(source.id,signal,source)).download_url};
     media=await findAttachment(item,context);check();
     if(!media){job.stage=`正在获取文件 ${index+1}/${sources.length}…`;await (getAcquisition(item,context)?.state==='running'?getAcquisition(item,context)!:startAcquisition(item,context,async()=>item)).promise;check();media=await findAttachment(item,context);}
     if(!media?.cached||media.uploadSource.size!==source.size)throw Error('原文件尚未完整保存，请重试');
     const original=media.uploadSource,file={name:source.name,type:item.mime,size:source.size,lastModified:0,readPart:async(s:number,e:number)=>{check();return original.readPart?original.readPart(s,e):original.slice!(s,e);}};
     if(await fileDigest(file,check,loaded=>{job.stage=`正在核对文件 ${index+1}/${sources.length}…`;job.progress={phase:'hash',loaded,total:source.size};})!==source.sha256)throw Error('原文件完整性校验失败');
     check();const copy=await uploadChatFile(file,operation.key+'-file-'+index,(stage,progress)=>{check();job.stage=stage;job.progress=progress;},controller.signal,isVoiceMessage(source)?'voice':'file',source.duration_ms,peer);check();
     if(!matchesTarget(copy,source,peer,lease.account))throw Error('目标文件回执不匹配');
     prepared.push(copy);operation.body.preparedItems=[...prepared];updateWrite(lease.account,slot,operation.key,operation.body);check();
     try{await media.cacheAs?.({...copy,kind:item.kind,version:`${copy.ver}:${copy.sha256}`},context);}catch{}
     media.dispose();media=undefined;
    }
    job.stage='正在确认转发…';job.progress=undefined;
    const body:ChatSendBody={body:operation.body.caption,mention_usernames:[],attachment_ids:prepared.map(a=>a.id),project_id:null,work_item_id:null,...(peer?{recipient_username:peer}:{})};
    const receipt=await communication.send(body,operation.key+'-message',controller.signal);check();
    if(!receipt.message?.id||receipt.message.author_username!==lease.account||(receipt.message.conversation_peer||'')!==peer||JSON.stringify(receipt.message.attachments.map(a=>a.id))!==JSON.stringify(body.attachment_ids))throw Error('转发结果尚未确认，请继续原操作');
    job.messageId=receipt.message.id;useChatStore().acceptSent(lease.account,peer,receipt.message);
    if(channel==='single')endWrite(lease.account,slot,operation.key);job.state='complete';job.stage='已转发';notifyChatWake(lease.account,'live',[],{kinds:['chat_message','conversation_list'],conversationPeers:[peer],groupFilesChanged:!peer});return true;
   }
   const source=operation.body.attachment,peer=operation.body.peer;
   const context={account:lease.account,computer:'cloud',provider:'company',thread:'group'};
   // Once a target copy is confirmed, it is also an immutable recovery source.
   // Retrying a lost message receipt need not depend on the old chat/file still
   // being available or on a cache that may have been reclaimed.
   const readable=operation.body.prepared||source;
   if(operation.body.prepared&&!matchesTarget(readable,source,peer,lease.account))throw Error('目标文件回执不匹配，请继续原操作');
   const item:Attachment={...readable,mime:effectiveMime(readable.name,readable.mime),kind:effectiveKind(readable.name,readable.mime),version:`${readable.ver}:${readable.sha256}`,groupAttachment:readable,resolveUrl:async signal=>(await getChatDownload(readable.id,signal,readable)).download_url};
   const body:ChatSendBody={body:operation.body.caption,mention_usernames:[],attachment_ids:[],project_id:null,work_item_id:null,...(peer?{recipient_username:peer}:{})};
   let committed:{message:ChatMessage}|undefined,prepared=operation.body.prepared;
   // A durable target receipt already passed byte/recipient checks. Reconfirm
   // the same message key without depending on a reclaimed cache or new read.
   if(!prepared){
    media=await findAttachment(item,context);check();
    if(!media){
     job.stage='正在获取原文件…';
     // Acquisition is shared with preview/download and keeps working across
     // routes. Pausing this forward does not cancel another reader's download.
     await (getAcquisition(item,context)?.state==='running'?getAcquisition(item,context)!:startAcquisition(item,context,async()=>item)).promise;check();
     media=await findAttachment(item,context);check();
    }
    if(!media?.cached||media.uploadSource.size!==source.size)throw Error('原文件尚未完整保存在本机，请重试');
    const original=media.uploadSource,file={name:source.name,type:item.mime,size:source.size,lastModified:0,readPart:async(s:number,e:number)=>{check();return original.readPart?original.readPart(s,e):original.slice!(s,e);}};
    job.stage='正在核对原文件…';
    if(await fileDigest(file,check,loaded=>{job.progress={phase:'hash',loaded,total:source.size};})!==source.sha256)throw Error('原文件完整性校验失败，已停止转发');
    check();
    const progress=(stage:string,p?:TransferProgress)=>{check();job.stage=stage;job.progress=p;};
    if(operation.body.smallMedia===undefined){operation.body.smallMedia=canSendSmallMedia(file,body,peer,isVoiceMessage(source)?'voice':'file');updateWrite(lease.account,slot,operation.key,operation.body);}
    check();
    if(operation.body.smallMedia){committed=await sendSmallMedia(file,body,peer,isVoiceMessage(source)?'voice':'file',source.duration_ms,operation.key+'-message',controller.signal,progress);check();prepared=committed.message.attachments[0];}
    else if(!prepared){
     prepared=await uploadChatFile(file,operation.key+'-file',progress,controller.signal,isVoiceMessage(source)?'voice':'file',source.duration_ms,peer,peer?{body,key:operation.key+'-message',onReceipt:message=>{check();committed={message};}}:undefined);check();
    }
    if(!prepared||!matchesTarget(prepared,source,peer,lease.account))throw Error('目标文件回执不匹配，请继续原操作');
    operation.body.prepared=prepared;updateWrite(lease.account,slot,operation.key,operation.body);check();
   }
   check();
   job.stage='正在确认转发…';job.progress=undefined;
   const receipt=committed||await communication.send({...body,attachment_ids:[prepared!.id]},operation.key+'-message',controller.signal);check();
   if(!receipt.message?.id||receipt.message.author_username!==lease.account||(receipt.message.conversation_peer||'')!==peer||receipt.message.attachments.length!==1||receipt.message.attachments[0].id!==prepared!.id)throw Error('转发结果尚未确认，请继续原操作');
   job.messageId=receipt.message.id;useChatStore().acceptSent(lease.account,peer,receipt.message);
   try{await media?.cacheAs?.({...prepared!,kind:item.kind,version:`${prepared!.ver}:${prepared!.sha256}`},context);}catch{/* Message receipt is authoritative; cache linking is best effort. */}
   // Batch ownership keeps this receipt/protocol until its parent has durably
   // advanced. A crash between child success and parent progress must retain it.
   check();if(channel==='single')endWrite(lease.account,slot,operation.key);job.state='complete';job.stage='已转发';
   notifyChatWake(lease.account,'live',[],{kinds:['chat_message','conversation_list'],conversationPeers:[peer],groupFilesChanged:!peer});
   return true;
  }catch(e){job.state=controller.signal.aborted||!lease.valid()?'paused':'error';job.error=userError(e,'转发未完成，原操作已保留，请重试');job.stage=job.state==='paused'?'已暂停':'转发未完成';job.progress=undefined;return false;}
  finally{media?.dispose();for(const [key,value] of jobs)if(value!==job&&value.state!=='running')jobs.delete(key);}
 })();
 return job;
}

// Prepare one verified target-audience copy without sending a message. Used by
// merged records so child files never appear as unrelated chat messages.
export async function copyForwardAttachment(source:ChatAttachment,peer:string,key:string,signal:AbortSignal,check:()=>void,progress:(stage:string,p?:TransferProgress)=>void){
 const lease=captureApiLease(),context={account:lease.account,computer:'cloud',provider:'company',thread:'group'};
 const item:Attachment={...source,mime:effectiveMime(source.name,source.mime),kind:effectiveKind(source.name,source.mime),version:`${source.ver}:${source.sha256}`,groupAttachment:source,resolveUrl:async s=>(await getChatDownload(source.id,s,source)).download_url};
 let media=await findAttachment(item,context);
 try{
  check();if(!media){await(getAcquisition(item,context)?.state==='running'?getAcquisition(item,context)!:startAcquisition(item,context,async()=>item)).promise;check();media=await findAttachment(item,context);}
  if(!media?.cached||media.uploadSource.size!==source.size)throw Error('原文件尚未完整读取，请重试');
  const original=media.uploadSource,file={name:source.name,type:item.mime,size:source.size,lastModified:0,readPart:async(s:number,e:number)=>{check();return original.readPart?original.readPart(s,e):original.slice!(s,e);}};
  if(await fileDigest(file,check)!==source.sha256)throw Error('原文件完整性校验失败');check();
  const copy=await uploadChatFile(file,key,progress,signal,isVoiceMessage(source)?'voice':'file',source.duration_ms,peer);check();
  if(!matchesTarget(copy,source,peer,lease.account))throw Error('目标文件回执不匹配');return copy;
 }finally{media?.dispose();}
}

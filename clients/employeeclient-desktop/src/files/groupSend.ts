import {canSendSmallMedia,sendSmallMedia} from './smallMedia';
import type {ChatMessage} from '@/api/types';
import {uploadChatFile} from '@/chat/files';
import {findAttachment,sourceIdentity,type Attachment,type MediaContext} from '@/collaboration/media';
import {cachedCloudFile,cloudFileAttachment,cloudFileContext,shareCloudFile,type CloudFile} from './cloud';
import {getAcquisition,startAcquisition} from './acquisition';
import {startCloudJob} from './cloudJobs';
import {communication} from '@/api/endpoints';
import {useChatStore} from '@/store/chat';
import {cacheLease} from '@/platform/attachmentCache';
import {newIdempotencyKey} from '@/api/client';

export type GroupSendJob={
 key:string;account:string;state:'running'|'complete'|'error';stage:string;
 progressPercent?:number;messageId?:string;error?:string;promise:Promise<GroupSendJob>;
};
const jobs=new Map<string,GroupSendJob>();
const controllers=new Map<string,AbortController>();
export const GROUP_SEND_CHANGED='qn:group-file-send';
const identity=(a:Attachment,c:MediaContext)=>JSON.stringify(sourceIdentity(a,c));
type Intent={key:string;note:string;createdAt:number;messageId?:string;smallMedia?:boolean};
const storageKey=(a:Attachment,c:MediaContext)=>'qn.group-send-intent:'+identity(a,c);
function readIntent(a:Attachment,c:MediaContext):Intent|undefined{
 try{
  const value=JSON.parse(localStorage.getItem(storageKey(a,c))||'null');
  if(typeof value?.key==='string'&&typeof value?.note==='string'&&Number.isSafeInteger(value.createdAt)&&Date.now()-value.createdAt<7*86400000)return value;
 }catch{}
}
function writeIntent(a:Attachment,c:MediaContext,intent:Intent){
 try{localStorage.setItem(storageKey(a,c),JSON.stringify(intent));}
 catch{throw Error('无法保留文件发送操作，请检查本机存储空间');}
}
export function completedGroupSend(a:Attachment,c:MediaContext){return readIntent(a,c)?.messageId;}
export function pendingGroupSendNote(a:Attachment,c:MediaContext){
 const intent=readIntent(a,c);
 return intent&&!intent.messageId?intent.note:undefined;
}
export function beginNewGroupSend(a:Attachment,c:MediaContext){
 const prior=readIntent(a,c);
 if(prior?.messageId){
  try{localStorage.removeItem(storageKey(a,c));}catch{}
  if(jobs.get(identity(a,c))?.state==='complete')jobs.delete(identity(a,c));
 }
}
export function getGroupSend(a:Attachment,c:MediaContext){return jobs.get(identity(a,c));}
function changed(job:GroupSendJob){window.dispatchEvent(new CustomEvent(GROUP_SEND_CHANGED,{detail:job}));}

export function startGroupSend(a:Attachment,c:MediaContext,note:string,knownFile?:CloudFile):GroupSendJob{
 const key=identity(a,c),previous=jobs.get(key);
 if(previous?.state==='running')return previous;
 const job:GroupSendJob={key,account:c.account,state:'running',stage:'正在准备文件…',promise:undefined!};
 const controller=new AbortController(),valid=cacheLease(c.account);
 const check=()=>{if(controller.signal.aborted||!valid())throw Error('账号已切换，文件未发送');};
 controllers.set(key,controller);
 jobs.set(key,job);changed(job);
 job.promise=(async()=>{
  let cached:Awaited<ReturnType<typeof findAttachment>>;
  try{
   const text=note.trim();
   let intent=readIntent(a,c);
   if(intent?.note!==undefined&&intent.note!==text&&!intent.messageId)throw Error('这份文件有未确认的发送，请先用原附言核对');
   if(!intent||intent.messageId){intent={key:newIdempotencyKey('group-file-send'),note:text,createdAt:Date.now()};writeIntent(a,c,intent);}
   let shared=a.groupAttachment,committed:{message:ChatMessage}|undefined;
   let file=knownFile||cachedCloudFile(a,c);
   if(shared?.id.startsWith('private:')){
    // This explicit forward publishes a separate group copy. Never put a
    // private reference/key in the group, or reuse the private composer.
    await startAcquisition(a,c,async()=>a).promise;check();cached=await findAttachment(a,c);check();
    if(!cached)throw Error('私聊原文件尚未取得，请重试');
    const original=cached.uploadSource;
    const upload={name:a.name,type:a.mime,size:original.size,lastModified:0,readPart:async(s:number,e:number)=>original.readPart?original.readPart(s,e):original.slice!(s,e)},body={body:text,attachment_ids:[],mention_usernames:[]},purpose=a.groupAttachment?.purpose||'file',duration=a.groupAttachment?.duration_ms;
    const progress=(stage:string,p?:import('./transferProgress').TransferProgress)=>{job.stage=stage;job.progressPercent=p?.phase==='upload'?p.loaded/p.total*100:undefined;changed(job);};
    intent.smallMedia??=canSendSmallMedia(upload,body,'',purpose,duration);writeIntent(a,c,intent);
    if(intent.smallMedia){committed=await sendSmallMedia(upload,body,'',purpose,duration,intent.key,controller.signal,progress);shared=committed.message.attachments[0];}
    else shared=await uploadChatFile(upload,intent.key+'-public',progress,controller.signal,purpose,duration);
    check();await cached.cacheAs?.({...shared,kind:a.kind,version:`${shared.ver}:${shared.sha256}`},{...c,thread:'group'});
   }
   if(!shared){
   if(!file){
    const acquiring=getAcquisition(a,c);
    if(acquiring?.state==='running')await acquiring.promise.catch(()=>undefined);
    check();
    cached=await findAttachment(a,c);
    check();
    if(!cached&&!Number.isSafeInteger(a.size)){
     job.stage='正在获取文件大小…';changed(job);
     await startAcquisition(a,c,async()=>a).promise;
     cached=await findAttachment(a,c);check();
    }
    job.stage='正在同步文件…';changed(job);
    try{file=(await startCloudJob(a,c,cached?.uploadSource,undefined,a.name).promise).file;}
    catch(error){
     // A Mac can upload its own generated file without first downloading it
     // to the phone. If that route is unavailable, use the remote file once.
     if(cached||(!a.url&&!a.resolveUrl))throw error;
     check();job.stage='正在从文件来源获取…';changed(job);
     await startAcquisition(a,c,async()=>a).promise;
     cached=await findAttachment(a,c);
     check();
     file=(await startCloudJob(a,c,cached?.uploadSource,undefined,a.name).promise).file;
    }
   }
   check();
   if(!file)throw Error('梦空间未确认文件，请重试');
   job.stage='正在准备群文件…';changed(job);
   shared=await shareCloudFile(file,controller.signal,stage=>{job.stage=stage;changed(job);});
   }
   check();
   const chat=useChatStore();
   check();
   const message={body:text,attachment_ids:[shared.id],mention_usernames:[]};
   job.stage='正在发送到工作群…';job.progressPercent=undefined;changed(job);
   // Forwarding owns its immutable intent, independent of the open group or direct composer.
   const receipt=committed||await communication.send(message,intent.key);check();const sent=receipt.message;
   if(!sent?.id)throw Error('群消息尚未确认发送，请重试');
   chat.acceptSent(c.account,'',sent);
   if(!sent.attachments?.some(file=>file.id===shared.id))throw Error('群消息回执未包含这份文件，请到工作群核对');
   job.messageId=sent.id;
   writeIntent(a,c,{...intent,messageId:sent.id});
   // The public copy has a new attachment ID but identical verified bytes.
   // Link its cache identity before opening the group; otherwise the same
   // phone downloads the file again immediately after forwarding it.
   if(file&&shared.sha256===file.sha256&&shared.size===file.size){
    let source=cached;
    try{
     source ||= await findAttachment(a,c);
     source ||= await findAttachment(cloudFileAttachment(file),cloudFileContext(c.account));
     if(source){
      const groupContext:MediaContext={account:c.account,computer:'cloud',provider:'company',thread:'group'};
      const publicAttachment:Attachment={id:shared.id,name:shared.name,mime:shared.mime,kind:'file',size:shared.size,sha256:shared.sha256,version:`${shared.ver}:${shared.sha256}`};
      await source.cacheAs?.(publicAttachment,groupContext);
     }
    }catch{ /* Group delivery is already confirmed; cache linking is best effort. */ }
    finally{if(source!==cached)source?.dispose();}
   }
   job.state='complete';job.stage='已发送到工作群';changed(job);
   return job;
  }catch(e){job.state='error';job.error=e instanceof Error?e.message:'发送未完成，请重试';job.stage='';changed(job);throw e;}
  finally{cached?.dispose();controllers.delete(key);if(jobs.size>40)for(const [oldKey,old] of jobs)if(old.state!=='running'&&oldKey!==key){jobs.delete(oldKey);if(jobs.size<=32)break;}}
 })();
 return job;
}

export function clearGroupSends(account:string){for(const [key,job] of jobs)if(job.account===account){controllers.get(key)?.abort();jobs.delete(key);}try{for(const key of Object.keys(localStorage))if(key.startsWith('qn.group-send-intent:')&&JSON.parse(key.slice('qn.group-send-intent:'.length))[0]===account)localStorage.removeItem(key);}catch{}}

import {shallowReactive} from 'vue';
import type {ChatMessage,ChatSendBody} from '@/api/types';
import type {ChatAttachment} from './files';
import {uploadChatFile} from './files';
import {captureApiLease} from '@/api/client';
import {communication} from '@/api/endpoints';
import {beginWrite,endWrite,pendingWrite,updateWrite,type PendingWrite} from '@/session/pendingWrites';
import {canForwardMessage} from './batchForward';
import {copyForwardAttachment} from './mediaForward';
import {readChatRecord,CHAT_RECORD_MIME,CHAT_RECORD_SCHEMA,isChatRecord,type ChatRecord,type RecordMessage} from './chatRecord';
import {MAX_RECORD_BYTES,MAX_RECORD_FILES,validateRecord} from '../../shared/chat-record.mjs';
import {useChatStore} from '@/store/chat';
import {notifyChatWake} from '@/platform/chatEvents';
import {userError} from '@/domain/userError.mjs';
const slot='chat-record-forward';
export type MergedForward={peer:string;messages:RecordMessage[];copies:Record<string,ChatAttachment>;root?:ChatAttachment;childIds?:string[]};
export type MergedJob={state:'running'|'paused'|'error'|'complete';error:string;promise:Promise<number|false>;cancel:()=>void};
const jobs=new Map<string,MergedJob>(),identity=(account:string,key:string)=>JSON.stringify([account,key]);
export function readMergedForward(account:string){const value=pendingWrite<MergedForward>(account,slot,'company');if(value){if(typeof value.body.peer!=='string'||!value.body.copies||typeof value.body.copies!=='object')throw Error('聊天记录转发恢复信息不可读取');validateRecord({schema:CHAT_RECORD_SCHEMA,title:'聊天记录',messages:value.body.messages});}return value;}
export function prepareMergedForward(account:string,peer:string,messages:ChatMessage[],key?:string){
 if(readMergedForward(account))throw Error('请先处理上次聊天记录转发');const unique=[...new Map(messages.map(m=>[m.id,m])).values()].sort((a,b)=>a.seq-b.seq);
 if(!unique.length||unique.length>20||unique.some(m=>!canForwardMessage(m)))throw Error('请选择20条以内可读取的消息');
 const rows=unique.map(m=>({author:m.author_name||'成员',created_at:m.created_at,body:m.body,attachments:JSON.parse(JSON.stringify(m.attachments))}));
 return beginWrite<MergedForward>(account,slot,'company',{peer,messages:rows,copies:{}},key);
}
export function getMergedJob(account:string,key:string){return jobs.get(identity(account,key));}
export function pauseMergedForward(account:string){for(const [key,job]of jobs)if(JSON.parse(key)[0]===account&&job.state==='running')job.cancel();}
export function discardMergedForward(account:string,key:string){if(getMergedJob(account,key)?.state==='running')throw Error('请先暂停转发');endWrite(account,slot,key);jobs.delete(identity(account,key));}
export function startMergedForward(intent:PendingWrite<MergedForward>):MergedJob{
 const lease=captureApiLease(),saved=readMergedForward(lease.account);if(!lease.valid()||!saved||saved.key!==intent.key||JSON.stringify(saved.body)!==JSON.stringify(intent.body))throw Error('转发记录或账号已变化');
 const old=getMergedJob(lease.account,intent.key);if(old?.state==='running')return old;
 const operation=JSON.parse(JSON.stringify(saved)) as PendingWrite<MergedForward>,controller=new AbortController();let expected=JSON.stringify(saved.body);
 const job=shallowReactive<MergedJob>({state:'running',error:'',promise:undefined!,cancel:()=>{controller.abort();job.state='paused';}});jobs.set(identity(lease.account,intent.key),job);
 const check=()=>{if(controller.signal.aborted||!lease.valid())throw new DOMException('已暂停','AbortError');const current=readMergedForward(lease.account);if(!current||current.key!==operation.key||JSON.stringify(current.body)!==expected)throw Error('转发记录已变化');};
 const persist=()=>{check();updateWrite(lease.account,slot,operation.key,operation.body);expected=JSON.stringify(operation.body);};
 job.promise=(async()=>{try{
  check();const peer=operation.body.peer,childIds=new Set<string>();let files=0;
  const include=(id:string)=>{childIds.add(id);if(childIds.size>MAX_RECORD_FILES)throw Error('聊天记录附件过多，请减少所选消息');};
  const copy=async(source:ChatAttachment,path:string,depth:number):Promise<ChatAttachment>=>{
   check();if(++files>MAX_RECORD_FILES||depth>3)throw Error('聊天记录层级或附件过多，请减少所选消息');
   let record:ChatRecord|undefined;if(isChatRecord(source))record=await rebind(await readChatRecord(source,controller.signal),path,depth+1);
   check();const retained=operation.body.copies[path];if(retained){if(isChatRecord(source))for(const id of retained.record_attachment_ids||[])include(id);include(retained.id);return retained;}
   let target:ChatAttachment;
   if(record){const file=recordFile(record);target=await uploadChatFile(file,operation.key+'-'+path,()=>check(),controller.signal,'file',undefined,peer);target={...target,record_attachment_ids:[...childIds]};}
   else target=await copyForwardAttachment(source,peer,operation.key+'-'+path,controller.signal,check,()=>check());
   check();operation.body.copies[path]=target;persist();include(target.id);return target;
  };
  const rebind=async(record:ChatRecord,path:string,depth:number):Promise<ChatRecord>=>{
   validateRecord(record);const messages:RecordMessage[]=[];
   for(let i=0;i<record.messages.length;i++){const m=record.messages[i],attachments:ChatAttachment[]=[];for(let j=0;j<m.attachments.length;j++)attachments.push(await copy(m.attachments[j],path+'-'+i+'-'+j,depth));messages.push({...m,attachments});}
   return {...record,messages};
  };
  if(!operation.body.root){
   let record:ChatRecord;
   const rows=operation.body.messages;
   if(rows.length===1&&!rows[0].body&&rows[0].attachments.length===1&&isChatRecord(rows[0].attachments[0]))record=await rebind(await readChatRecord(rows[0].attachments[0],controller.signal),'r',0);
   else record=await rebind({schema:CHAT_RECORD_SCHEMA,title:recordTitle(rows),messages:rows},'r',0);
   check();const root=await uploadChatFile(recordFile(record),operation.key+'-record',()=>check(),controller.signal,'file',undefined,peer);check();operation.body.root=root;operation.body.childIds=[...childIds];persist();
  }
  check();const body:ChatSendBody={body:'',mention_usernames:[],attachment_ids:[operation.body.root!.id],record_attachment_ids:operation.body.childIds||[],...(peer?{recipient_username:peer}:{})};
  const receipt=await communication.send(body,operation.key+'-message',controller.signal);check();
  if(!receipt.message?.id||receipt.message.author_username!==lease.account||(receipt.message.conversation_peer||'')!==peer||receipt.message.attachments.length!==1||receipt.message.attachments[0].id!==operation.body.root!.id)throw Error('转发结果尚未确认，请重试');
  useChatStore().acceptSent(lease.account,peer,receipt.message);notifyChatWake(lease.account,'live',[],{kinds:['chat_message','conversation_list'],conversationPeers:[peer]});endWrite(lease.account,slot,operation.key);job.state='complete';return operation.body.messages.length;
 }catch(e){job.state=controller.signal.aborted||!lease.valid()?'paused':'error';job.error=userError(e,'转发未完成，请重试');return false;}finally{for(const [key,value]of jobs)if(value!==job&&value.state!=='running')jobs.delete(key);}})();return job;
}
function recordTitle(messages:RecordMessage[]){const names=[...new Set(messages.map(m=>m.author))];return (names.length===1?names[0]+'的聊天记录':names.slice(0,2).join('和')+(names.length>2?'等人的':'的')+'聊天记录').slice(0,160);}
function recordFile(record:ChatRecord){validateRecord(record);const file=new File([JSON.stringify(record)],'聊天记录.qnchat',{type:CHAT_RECORD_MIME,lastModified:0});if(file.size>MAX_RECORD_BYTES)throw Error('聊天记录内容过多，请减少所选消息');return file;}

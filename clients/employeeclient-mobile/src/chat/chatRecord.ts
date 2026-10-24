import type {ChatAttachment} from './files';
import {getChatDownload} from './files';
import {captureApiLease} from '@/api/client';
import {findAttachment,type Attachment} from '@/collaboration/media';
import {startAcquisition,getAcquisition} from '@/files/acquisition';
import {CHAT_RECORD_MIME,CHAT_RECORD_SCHEMA,MAX_RECORD_BYTES,validateRecord,isChatRecord} from '../../shared/chat-record.mjs';
export {CHAT_RECORD_MIME,CHAT_RECORD_SCHEMA,isChatRecord};
export type RecordMessage={author:string;created_at:number;body:string;attachments:ChatAttachment[]};
export type ChatRecord={schema:string;title:string;messages:RecordMessage[]};
export const recordContext=(account:string)=>({account,computer:'cloud',provider:'company',thread:'group'});
export function recordSource(a:ChatAttachment):Attachment{return {...a,kind:'file',version:`${a.ver}:${a.sha256}`,groupAttachment:a,resolveUrl:async signal=>(await getChatDownload(a.id,signal,a)).download_url};}
export async function readChatRecord(a:ChatAttachment,signal:AbortSignal):Promise<ChatRecord>{
 const lease=captureApiLease(),check=()=>{if(signal.aborted||!lease.valid())throw new DOMException('已取消','AbortError');};
 if(!isChatRecord(a)||a.size>MAX_RECORD_BYTES)throw Error('聊天记录过大或格式不可读取');
 const item=recordSource(a),ctx=recordContext(lease.account);let held=await findAttachment(item,ctx);check();
 try{
  if(!held){await(getAcquisition(item,ctx)?.state==='running'?getAcquisition(item,ctx)!:startAcquisition(item,ctx,async()=>item)).promise;check();held=await findAttachment(item,ctx);}
  if(!held?.cached)throw Error('聊天记录未能完整读取，请重试');const s=held.uploadSource;if(s.size!==a.size||s.size>MAX_RECORD_BYTES)throw Error('聊天记录大小不一致');
  const blob=s.readPart?await s.readPart(0,s.size):s.slice?.(0,s.size);check();if(!blob)throw Error('聊天记录暂不可读');
  const result=validateRecord(JSON.parse(await blob.text())) as ChatRecord;check();
  const permitted=new Set(a.record_attachment_ids||[]);
  if(result.messages.some(m=>m.attachments.some(file=>!permitted.has(file.id))))throw Error('聊天记录附件授权不完整，请更新或重新转发');
  return result;
 }finally{held?.dispose();}
}

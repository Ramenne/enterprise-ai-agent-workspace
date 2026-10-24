import {apiConfig,captureApiLease} from '@/api/client';
import {serviceOrigin} from '@/api/runtime';
import {uploadResponse} from '@/native/upload-progress.mjs';
import {NativeError} from '@/native/client.mjs';
import {fileDigest} from './uploadReceipts';
import {effectiveMime} from './fileType';
import {retainUploadedAttachment} from '@/collaboration/media';
import type {UploadFile,ChatAttachment} from '@/chat/files';
import type {ChatSendBody,ChatMessage} from '@/api/types';
import type {TransferReporter} from './transferProgress';
function metadata(file:UploadFile,body:ChatSendBody,peer:string,purpose:string,duration?:number,sha256='0'.repeat(64)){
 return {file:{name:file.name,mime:effectiveMime(file.name,file.type),size:file.size,sha256,purpose,...(duration?{duration_ms:duration}:{})},peer,message:body};
}
export function canSendSmallMedia(file:UploadFile,body:ChatSendBody,peer:string,purpose:string,duration?:number){
 return apiConfig.fastMedia===true&&file.size>0&&file.size<=2*1024*1024&&!(body.attachment_ids||[]).length&&new TextEncoder().encode(JSON.stringify(metadata(file,body,peer,purpose,duration))).length<=2000;
}
// The job freezes this choice before sending. An uncertain response never
// falls back to a different protocol, recipient or idempotency key.
export async function sendSmallMedia(file:UploadFile,body:ChatSendBody,peer:string,purpose:string,duration:number|undefined,key:string,signal:AbortSignal,report:TransferReporter){
 const lease=captureApiLease(),check=()=>{if(signal.aborted||!lease.valid())throw new DOMException('已暂停','AbortError');};
 const digest=await fileDigest(file,check,loaded=>report('正在核验文件…',{phase:'hash',loaded,total:file.size}));check();
 const bytes=new TextEncoder().encode(JSON.stringify(metadata(file,body,peer,purpose,duration,digest)));
 if(bytes.length>2000)throw Error('发送内容已变更，请重新选择');
 const source=file instanceof Blob?file:await file.readPart?.(0,file.size)||file.slice!(0,file.size);check();
 report('正在上传文件…',{phase:'upload',loaded:0,total:file.size});
 const prefix=new Uint8Array(4);new DataView(prefix.buffer).setUint32(0,bytes.length);
 const payload=new Blob([prefix,bytes,source],{type:'application/octet-stream'});
 const response=await uploadResponse((serviceOrigin()||'')+'/business/v1/media-transfers',payload,signal,(sent:number)=>{check();const loaded=Math.max(0,sent-4-bytes.length);report(loaded>=file.size?'正在确认发送…':'正在上传文件…',{phase:loaded>=file.size?'verify':'upload',loaded,total:file.size});},globalThis.fetch,{'content-type':'application/octet-stream','idempotency-key':key});check();
 const result=await response.json();check();
 if(!response.ok){if(response.status===401&&lease.valid())apiConfig.onUnauthorized();throw new NativeError(result.error_code||'media_transfer_unavailable',response.status);}
 const message=result.message as ChatMessage,attachment=message?.attachments?.[0] as ChatAttachment;
 if(!message?.id||message.author_username!==lease.account||(message.conversation_peer||'')!==peer||message.attachments.length!==1||attachment.sha256!==digest||attachment.size!==file.size)throw Error('发送回执不完整，请重试核对');
 void retainUploadedAttachment({...attachment,kind:'file',version:`${attachment.ver}:${attachment.sha256}`},{account:lease.account,computer:'cloud',provider:'company',thread:'group'},file,signal);
 return {message};
}

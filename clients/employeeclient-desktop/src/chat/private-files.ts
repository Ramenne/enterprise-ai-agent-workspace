import type {TransferReporter} from '@/files/transferProgress';
import {apiRequest,captureApiLease} from '@/api/client';
import {serviceOrigin} from '@/api/runtime';
import {saveNativeFile} from '@/files/native-library';
import {fileDigest,resumeIdentity,rememberedUpload,rememberUpload} from '@/files/uploadReceipts';
import {encryptedSource,encryptedSize} from '../../shared/private-media.mjs';
import {retainUploadedAttachment} from '@/collaboration/media';
import type {ChatSendBody,ChatMessage} from '@/api/types';
export type PrivateCommit={body:ChatSendBody;key:string;onReceipt:(message:ChatMessage)=>void};
import type {ChatAttachment,UploadFile} from './files';
export async function uploadPrivateFile(file:UploadFile,key:string,peer:string,purpose:string,durationMs:number|undefined,signal:AbortSignal|undefined,progress:TransferReporter,commit?:PrivateCommit){
 if(encryptedSize(file.size)>100*1024**3)throw Error('私聊文件过大，请选择较小文件');
 const lease=captureApiLease(),check=()=>{if(signal?.aborted||!lease.valid())throw new DOMException('已暂停','AbortError');};
 const identity=await resumeIdentity(lease.account,file,'private:'+peer+':'+purpose);check();key=rememberedUpload(identity,key);rememberUpload(identity,key);
 progress('正在准备文件…');const sha256=await fileDigest(file,check,loaded=>progress('正在核验文件…',{phase:'hash',loaded,total:file.size}));
 const grant=await apiRequest<any>('POST','/business/v1/private-attachments',{body:{peer,name:file.name,mime:file.type||'application/octet-stream',size:file.size,sha256,purpose,...(durationMs?{duration_ms:durationMs}:{})},idempotencyKey:key,signal});check();
 let attachment:ChatAttachment=grant.attachment;
 if(!attachment){
  const source=await encryptedSource(file,grant,check);
  const saved=await saveNativeFile(source,key+'-private-upload',{internal_encrypted:true},signal,progress,false);check();
  progress(commit?'正在发送…':'正在确认私有文件…');
  const result=await apiRequest<{attachment:ChatAttachment;message?:ChatMessage}>('POST','/business/v1/private-attachments/'+grant.id+(commit?'/commit':'/bind'),{body:{fixed_ref:saved.fixed_ref,...(commit?{message:commit.body}:{})},idempotencyKey:commit?.key||key+'-bind',signal});check();attachment=result.attachment;if(commit){if(!result.message?.attachments.some(a=>a.id===attachment.id))throw Error('发送回执未包含文件');commit.onReceipt(result.message);}
 }
 void retainUploadedAttachment({...attachment,kind:'file',version:`${attachment.ver}:${attachment.sha256}`},{account:lease.account,computer:'cloud',provider:'company',thread:'group'},file,signal||new AbortController().signal).catch(()=>false);
 check();return attachment;
}
export async function privateDownload(id:string,signal?:AbortSignal){
 const ref=id.replace(/^private:/,''),result=await apiRequest<{attachment:ChatAttachment}>('GET','/business/v1/private-attachments/'+ref,{signal});
 return {attachment:result.attachment,download_url:new URL((serviceOrigin()||'')+'/business/v1/private-attachments/'+ref+'/file',window.location.href).href};
}

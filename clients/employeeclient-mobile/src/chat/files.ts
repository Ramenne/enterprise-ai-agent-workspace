import {effectiveMime} from '@/files/fileType';
import type {TransferReporter} from '@/files/transferProgress';
import {resumeIdentity,rememberedUpload,rememberUpload} from '@/files/uploadReceipts';
import {captureApiLease} from '@/api/client';
import {serviceOrigin} from '@/api/runtime';
import {nativeLibraryClient,EMPLOYEECLIENT_PROJECT,saveNativeFile,resolveNativeFile,renameNativeFile,type FixedFile} from '@/files/native-library';
import {uploadPrivateFile,privateDownload,type PrivateCommit} from './private-files';
export interface ChatAttachment {
 record_attachment_ids?:string[];
 owner_username?:string;private_peer?:string;original_name?:string;purpose?:import('./mediaKind').ChatMediaPurpose;duration_ms?:number;
 id:string;name:string;mime:string;size:number;file_id:string;ver:number;sha256:string;address:string;fixed_ref?:FixedFile;
 source_unavailable?:boolean;availability?:string;
}
export type UploadFile=Pick<File,'name'|'type'|'size'|'lastModified'>&{slice?:(start:number,end:number)=>Blob;readPart?:(start:number,end:number)=>Promise<Blob>};
export const MAX_CHAT_FILE_BYTES=100*1024**3;
export async function uploadChatFile(file:UploadFile,key:string,progress:TransferReporter=()=>{},signal?:AbortSignal,purpose:import('./mediaKind').ChatMediaPurpose='file',durationMs?:number,peer='',commit?:PrivateCommit):Promise<ChatAttachment>{
 const mime=effectiveMime(file.name,file.type);if(mime!==file.type){const original=file;file={name:original.name,type:mime,size:original.size,lastModified:original.lastModified,readPart:async(s,e)=>original.readPart?original.readPart(s,e):original.slice!(s,e)};}
 if(!file.size||file.size>MAX_CHAT_FILE_BYTES)throw Error('请选择100GB以内的文件');
 if(peer)return uploadPrivateFile(file,key,peer,purpose,durationMs,signal,progress,commit);
 const lease=captureApiLease(),identity=await resumeIdentity(lease.account,file,purpose);
 if(signal?.aborted||!lease.valid())throw new DOMException('已暂停','AbortError');
 key=rememberedUpload(identity,key);rememberUpload(identity,key);
 const saved=await saveNativeFile({name:file.name,type:file.type,size:file.size,lastModified:file.lastModified,readPart:async(s,e)=>file.readPart?file.readPart(s,e):file.slice!(s,e)},key,{purpose,...(durationMs?{duration_ms:durationMs}:{})},signal,progress);
 return {...saved,address:''};
}
export async function getChatDownload(id:string,signal?:AbortSignal,known?:ChatAttachment){
 if(known?.id===id&&/^[a-f0-9]{64}$/.test(known.sha256)&&Number.isSafeInteger(known.size)&&known.size>0&&!known.source_unavailable){
  const lease=captureApiLease();if(signal?.aborted||!lease.valid())throw new DOMException('已暂停','AbortError');
  if(id.startsWith('private:'))return {attachment:known,download_url:new URL((serviceOrigin()||'')+'/business/v1/private-attachments/'+encodeURIComponent(id.slice(8))+'/file',window.location.href).href};
  const f=known.fixed_ref;if(f&&id===f.material_id+':'+f.version_id&&f.sha256===known.sha256&&f.size===known.size){const c=nativeLibraryClient(signal);return {attachment:known,download_url:new URL(c.fileUrl(EMPLOYEECLIENT_PROJECT,f,known.name),window.location.href).href};}
 }
if(id.startsWith('private:'))return privateDownload(id,signal);const r=await resolveNativeFile(id,signal);return {attachment:{...r.file,address:''},download_url:r.download_url};}
export async function getChatVoiceDuration(id:string,signal?:AbortSignal){const r=await getChatDownload(id,signal);return {attachment:r.attachment};}
export async function renameChatFile(id:string,name:string){const {file}=await resolveNativeFile(id);return {attachment:{...await renameNativeFile(file,name),address:''}};}

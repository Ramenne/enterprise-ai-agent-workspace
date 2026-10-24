import {cacheLease} from '@/platform/attachmentCache';
import {captureApiLease} from '@/api/client';
import {attachmentRevision,type Attachment,type MediaContext} from '@/collaboration/media';
import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';
import type {UploadSource} from './multipart';
import type {ChatAttachment} from '@/chat/files';
import {effectiveMime,effectiveKind} from './fileType';
import {saveNativeFile,resolveNativeFile,renameNativeFile,nativeLibraryClient,storedFile,EMPLOYEECLIENT_PROJECT,type StoredFile} from './native-library';
export type CloudFile=StoredFile&{path?:string};
const sourceKey=(a:Attachment,c:MediaContext)=>bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([c.computer,c.provider,c.thread,a.id,attachmentRevision(a)]))));
const localKey=(a:Attachment,c:MediaContext)=>'qn.native.cloud-file:'+JSON.stringify([c.account,sourceKey(a,c)]);
export function cachedCloudFile(a:Attachment,c:MediaContext):CloudFile|undefined{try{const f=JSON.parse(localStorage.getItem(localKey(a,c))||'null');if(f?.fixed_ref&&f.state==='ready'&&(a.size===undefined||f.size===a.size))return f;}catch{}}
export const CLOUD_FILE_CHANGED='qn:cloud-file-changed';
export function cloudFilesRevision(account:string){return localStorage.getItem('qn.cloud-files-revision:'+account)||'';}
function retain(a:Attachment,c:MediaContext,f:CloudFile,changed=false){localStorage.setItem(localKey(a,c),JSON.stringify(f));if(changed){localStorage.setItem('qn.cloud-files-revision:'+c.account,crypto.randomUUID());window.dispatchEvent(new CustomEvent(CLOUD_FILE_CHANGED,{detail:{account:c.account,file:f}}));}return f;}
export async function lookupCloudFile(a:Attachment,c:MediaContext,signal?:AbortSignal){const lease=captureApiLease(),valid=cacheLease(c.account);const check=()=>{if(lease.account!==c.account||!lease.valid()||!valid()||signal?.aborted)throw new DOMException('已暂停','AbortError');};check();const cached=cachedCloudFile(a,c);if(!cached)return;const r=await resolveNativeFile(cached.id,signal);check();return retain(a,c,r.file);}
export async function verifyCloudContent(f:CloudFile,content:UploadSource,signal:AbortSignal,progress:(stage:string)=>void=()=>{}){
 if(content.size!==f.size)throw Error('原文件大小已变化，请重新保存');const hash=sha256.create();
 for(let offset=0;offset<content.size;offset+=4*1024**2){if(signal.aborted)throw new DOMException('已暂停','AbortError');const end=Math.min(content.size,offset+4*1024**2),part=content.readPart?await content.readPart(offset,end):content.slice!(offset,end);if(part.size!==end-offset)throw Error('原文件读取不完整');hash.update(new Uint8Array(await part.arrayBuffer()));progress(`核对文件 ${Math.floor(end/content.size*100)}%`);}
 if(signal.aborted)throw new DOMException('已暂停','AbortError');if(bytesToHex(hash.digest())!==f.sha256)throw Error('原文件内容已变化');
}
export async function saveCloudFile(a:Attachment,c:MediaContext,signal:AbortSignal,progress:(s:string)=>void,content?:UploadSource,verifyExisting?:(file:CloudFile)=>Promise<void>){
 const valid=cacheLease(c.account),lease=captureApiLease();if(lease.account!==c.account)throw Error('账号已变更');const check=()=>{if(!valid()||signal.aborted||!lease.valid())throw new DOMException('已暂停','AbortError');};check();
 const cached=await lookupCloudFile(a,c,signal);check();if(cached){if(content){if(verifyExisting)await verifyExisting(cached);else await verifyCloudContent(cached,content,signal,progress);}check();return cached;}
 if(!content)throw Error('协作电脑文件传输暂未接入；请先在手机选择原文件');
 const key='qn-file-'+sourceKey(a,c);const f=await saveNativeFile({name:a.name,type:a.mime,size:content.size,readPart:async(s,e)=>{check();return content.readPart?content.readPart(s,e):content.slice!(s,e);}},key,{source_key:sourceKey(a,c),purpose:'file'},signal,progress);check();return retain(a,c,f,true);
}
export async function cloudDownload(f:CloudFile,signal?:AbortSignal){return resolveNativeFile(f.id,signal);}
export async function shareCloudFile(f:CloudFile,signal:AbortSignal,_progress:(s:string)=>void,name=f.name):Promise<ChatAttachment>{
 // The file already belongs to the current team project. Selecting it prepares
 // a draft reference; only communication.send creates the actual chat message.
 const r=await resolveNativeFile(f.id,signal);return {...r.file,name,address:''};
}
export async function renameCloudFile(a:Attachment,c:MediaContext,f:CloudFile,name:string,signal?:AbortSignal){const valid=cacheLease(c.account),lease=captureApiLease();const check=()=>{if(lease.account!==c.account||!valid()||!lease.valid()||signal?.aborted)throw new DOMException('已暂停','AbortError');};check();const changed=await renameNativeFile(f,name,signal);check();return retain(a,c,changed,true);}
export function clearCloudFiles(account:string){for(const key of Object.keys(localStorage))if(key.startsWith('qn.native.cloud-file:'))try{if(JSON.parse(key.slice('qn.native.cloud-file:'.length))[0]===account)localStorage.removeItem(key);}catch{}}
export function cloudFileContext(account:string):MediaContext{return {account,computer:'cloud',provider:'personal',thread:'library'};}
export function cloudFileAttachment(f:CloudFile):Attachment{return {id:f.id,name:f.name,mime:effectiveMime(f.name,f.mime),size:f.size,version:`${f.ver}:${f.sha256}`,sha256:f.sha256,kind:effectiveKind(f.name,f.mime),resolveUrl:async signal=>(await cloudDownload(f,signal)).download_url};}
export async function listCloudFiles(before?:string,signal?:AbortSignal,q?:string){
 if(signal?.aborted)throw new DOMException('已暂停','AbortError');const client=nativeLibraryClient();
 const page=await client.rpc('mem.search',{project_id:EMPLOYEECLIENT_PROJECT,query:q?.trim()||'',limit:50,...(before?{cursor:before}:{})},undefined,signal);
 const files:CloudFile[]=[];for(const item of page.items||[]){const head=await client.head(EMPLOYEECLIENT_PROJECT,item.material_id);if(head.properties?.employeeclient&&!head.properties.employeeclient.internal_encrypted)files.push(storedFile(head));}
 return {files,next_cursor:page.next_cursor||null};
}

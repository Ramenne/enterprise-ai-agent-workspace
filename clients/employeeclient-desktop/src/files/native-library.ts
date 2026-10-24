import type {TransferProgress,TransferReporter} from './transferProgress';
import {retainUploadedAttachment,findAttachment} from '@/collaboration/media';
import {NativeClient,NativeError} from '@/native/client.mjs';
import {matchingUpload} from '@/native/reuse-upload.mjs';
import {captureApiLease,apiConfig} from '@/api/client';
import {serviceOrigin} from '@/api/runtime';
import type {UploadSource} from './multipart';
export const EMPLOYEECLIENT_PROJECT='ad44cc0e-159e-4e0f-a5ca-73d3920240d9';
export type FixedFile={material_id:string;version_id:string;sha256:string;size:number;local_version_no?:string;file_no?:string};
export type StoredFile={id:string;name:string;original_name:string;mime:string;size:number;file_id:string;ver:number;sha256:string;state:string;source_key:string;fixed_ref:FixedFile;purpose?:'file'|'voice';duration_ms?:number};
export function nativeLibraryClient(signal?:AbortSignal){
 const lease=captureApiLease(),client=new NativeClient({base:serviceOrigin(),signal,onUnauthorized:()=>{if(lease.valid())apiConfig.onUnauthorized();}}),rpc=client.rpc.bind(client);
 client.rpc=async(...args:any[])=>{if(!lease.valid())throw Error('账号已变更');if(lease.networkReady?.()===false)throw Error('连接恢复后即可操作');const result=await rpc(...args);if(!lease.valid())throw Error('账号已变更');return result;};
 return client;
}
export function storedFile(head:any,name?:string):StoredFile{
 const f=head.fixed_ref,m=head.properties?.employeeclient||{},filename=name||m.name||head.placements?.[0]?.logical_path?.split('/').at(-1)||'文件 '+(f.file_no||f.material_id);
 return {id:f.material_id+':'+f.version_id,name:filename,original_name:filename,mime:m.mime||'application/octet-stream',size:f.size,file_id:'m2_'+f.material_id,ver:Number(f.local_version_no)||1,sha256:f.sha256,state:'ready',source_key:m.source_key||'',fixed_ref:f,purpose:m.purpose||'file',...(m.duration_ms?{duration_ms:m.duration_ms}:{})};
}
export async function saveNativeFile(file:UploadSource&{name:string;type?:string;lastModified?:number},key:string,metadata:Record<string,unknown>,signal?:AbortSignal,progress:TransferReporter=()=>{},retain=true):Promise<StoredFile>{
 const client=nativeLibraryClient(signal),lease=captureApiLease();
 const active=()=>{if(signal?.aborted||!lease.valid())throw new DOMException('上传已暂停','AbortError');};
 const report=(p:TransferProgress)=>progress(p.phase==='hash'?'正在核验文件…':p.phase==='upload'?'正在上传文件…':'正在确认云端文件…',p);
 const storageKey='qn.mem-upload:'+lease.account+':'+key,metaKey=storageKey+':metadata';active();
 let op;try{op=JSON.parse(localStorage.getItem(storageKey)||'null');}catch{throw Error('上传接续记录无法读取');}
 let reused;const initialProperties={employeeclient:{...metadata,name:file.name,mime:file.type||'application/octet-stream'}};
 if(!op){
  progress('计算文件校验值…');
  const source={name:file.name,type:file.type,size:file.size,readPart:async(s:number,e:number)=>{active();const bytes=file.readPart?await file.readPart(s,e):file.slice!(s,e);active();return bytes;}};
  try{op=await client.prepareUpload(EMPLOYEECLIENT_PROJECT,source,key,report,initialProperties);active();localStorage.setItem(storageKey,JSON.stringify(op));}
  catch(error){if(!(error instanceof NativeError)||error.code!=='conflict')throw error;reused=await matchingUpload(client,EMPLOYEECLIENT_PROJECT,source,key,active);progress('复用校验一致的项目原文件…');}
 }
 progress('上传并核验原文件…');
 const result=reused?{fixed_refs:[reused]}:await client.finishUpload(op,{...file,readPart:async(start:number,end:number)=>{active();const p=file.readPart?await file.readPart(start,end):file.slice!(start,end);active();return p;}},report).catch((e:unknown)=>{throw Error('原文件发布：'+(e instanceof Error?e.message:'未完成'));});active();
 const fixed=result.fixed_refs[0];
 let completed;
 if(op?.properties?.employeeclient&&Object.entries(initialProperties.employeeclient).every(([k,v])=>op.properties.employeeclient[k]===v)){
  completed={fixed_ref:fixed,properties:op.properties};
 }else{
 const head=await client.head(EMPLOYEECLIENT_PROJECT,fixed.material_id);active();
 const args={project_id:EMPLOYEECLIENT_PROJECT,material_id:fixed.material_id,expected_revision:head.metadata_revision,properties:{...(head.properties||{}),employeeclient:{...metadata,name:file.name,mime:file.type||'application/octet-stream'}},idempotency_key:key+'-metadata'};
 // Keep the exact CAS and submission through an ambiguous response.
 let saved;try{saved=JSON.parse(localStorage.getItem(metaKey)||'null');}catch{throw Error('属性接续记录无法读取');}
 if(!saved){saved=args;localStorage.setItem(metaKey,JSON.stringify(saved));}
 await client.rpc('mem.metadata.patch',saved,saved.idempotency_key,signal).catch((e:unknown)=>{throw Error('文件属性保存：'+(e instanceof Error?e.message:'未完成'));});active();
 // Publication already verified immutable bytes; the CAS patch confirms these
 // exact properties. Keep that fixed version instead of rereading a mutable head.
 completed={...head,fixed_ref:fixed,properties:saved.properties};active();
 }
 localStorage.removeItem(storageKey);localStorage.removeItem(metaKey);
 const retainedFile=storedFile(completed);progress('保留已校验的本机文件…');
 // Remote publication already succeeded. Failure to retain local bytes must
 // not create a new upload or misreport the durable publication as failed.
 if(retain){
  const attachment={...retainedFile,kind:'file' as const,version:`${retainedFile.ver}:${retainedFile.sha256}`};
  const group={account:lease.account,computer:'cloud',provider:'company',thread:'group'};
  void retainUploadedAttachment(attachment,group,file,signal||new AbortController().signal).then(async kept=>{if(!kept||!lease.valid())return;const cached=await findAttachment(attachment,group);try{await cached?.cacheAs?.(attachment,{...group,provider:'personal',thread:'library'});}finally{cached?.dispose();}}).catch(()=>{});
 }
 active();return retainedFile;
}
export async function resolveNativeFile(id:string,signal?:AbortSignal){
 const [material_id,version_id]=id.split(':');if(!material_id||!version_id)throw Error('旧附件没有固定原文件映射');
 const client=nativeLibraryClient(signal),lease=captureApiLease();
 const [head,page]=await Promise.all([client.head(EMPLOYEECLIENT_PROJECT,material_id),client.rpc('mem.version.read',{project_id:EMPLOYEECLIENT_PROJECT,material_id,version_id,offset:0,limit:1,encoding:'base64'},undefined,signal)]);if(signal?.aborted||!lease.valid())throw new DOMException('已暂停','AbortError');
 // Reading an old fixed version stays old. Metadata may be current but cannot
 // silently turn a historical reference into the new head's bytes.

 if(!lease.valid())throw new DOMException('已暂停','AbortError');
 const file=storedFile({...head,fixed_ref:page.fixed_ref});return {file,download_url:new URL(client.fileUrl(EMPLOYEECLIENT_PROJECT,file.fixed_ref,file.name),window.location.href).href};
}
export async function renameNativeFile(file:StoredFile,name:string,signal?:AbortSignal){
 if(!name.trim()||name.length>200)throw Error('文件名无效');const client=nativeLibraryClient(signal),lease=captureApiLease();
 const check=()=>{signal?.throwIfAborted();if(!lease.valid())throw Error('账号已变更');};check();
 const head=await client.head(EMPLOYEECLIENT_PROJECT,file.fixed_ref.material_id);check();
 const key=crypto.randomUUID();await client.rpc('mem.metadata.patch',{project_id:EMPLOYEECLIENT_PROJECT,material_id:file.fixed_ref.material_id,expected_revision:head.metadata_revision,properties:{...head.properties,employeeclient:{...head.properties?.employeeclient,name:name.trim()}},idempotency_key:key},key);
 check();return {...file,name:name.trim()};
}

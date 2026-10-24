import {open,mkdir,lstat,realpath,mkdtemp,rename,rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {ConsumerError,HubApiClient} from './transport.js';
import {requireUuid,type ProjectionCheckpoint} from './projection.js';

export async function controlledDirectory(path:string):Promise<string>{
 const absolute=resolve(path);await mkdir(absolute,{recursive:true,mode:0o700});
 const info=await lstat(absolute);
 if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)!==0||(process.getuid&&info.uid!==process.getuid()))
  throw new ConsumerError('unsafe_local_directory');
 return realpath(absolute);
}
export async function readControlledJson(path:string,maxBytes=16*1024*1024):Promise<unknown>{
 let file;try{file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);}catch{throw new ConsumerError('local_file_unavailable');}
 try{const info=await file.stat();if(!info.isFile()||(info.mode&0o077)!==0||(process.getuid&&info.uid!==process.getuid())||info.size>maxBytes)
   throw new ConsumerError('unsafe_local_file');
  try{return JSON.parse(await file.readFile('utf8')) as unknown;}catch{throw new ConsumerError('invalid_local_json');}
 }finally{await file.close();}
}
export async function atomicJson(directory:string,name:string,value:unknown):Promise<string>{
 if(!/^[a-zA-Z0-9_-]+\.json$/.test(name))throw new ConsumerError('unsafe_local_filename');
 const root=await controlledDirectory(directory),temporary=join(root,'.'+randomUUID()+'.tmp'),target=join(root,name);
 const file=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{await file.writeFile(JSON.stringify(value));await file.sync();}finally{await file.close();}
 try{await rename(temporary,target);}catch{await rm(temporary,{force:true});throw new ConsumerError('local_commit_failed');}
 const dir=await open(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await dir.sync();}finally{await dir.close();}
 return target;
}
export class FileProjectionStore {
 constructor(readonly directory:string){}
 private filename(projectId:string,bindingId:string){
  requireUuid(projectId);if(!/^[a-f0-9]{64}$/.test(bindingId))throw new ConsumerError('invalid_credential_channel_binding');
  return projectId+'_'+bindingId+'.json';
 }
 async load(projectId:string,bindingId:string):Promise<ProjectionCheckpoint|undefined>{
  const name=this.filename(projectId,bindingId),root=await controlledDirectory(this.directory),path=join(root,name);
  try{const item=await readControlledJson(path) as ProjectionCheckpoint;
   if(item.binding_id!==bindingId||item.project_id!==projectId)throw new ConsumerError('checkpoint_channel_mismatch');return item;}
  catch(error){if(error instanceof ConsumerError&&error.code==='local_file_unavailable')return undefined;throw error;}
 }
 async save(checkpoint:ProjectionCheckpoint){return atomicJson(this.directory,this.filename(checkpoint.project_id,checkpoint.binding_id),checkpoint);}
}
export interface FixedReference {project_id:string;material_id:string;version_id:string;sha256:string;size:number;}
export function fixedReference(value:unknown):FixedReference {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new ConsumerError('invalid_fixed_reference');
 const item=value as Record<string,unknown>;
 if(typeof item['sha256']!=='string'||!/^[a-f0-9]{64}$/.test(item['sha256'])||typeof item['size']!=='number'||!Number.isSafeInteger(item['size'])||item['size']<0)
  throw new ConsumerError('invalid_fixed_reference');
 return {project_id:requireUuid(item['project_id']),material_id:requireUuid(item['material_id']),version_id:requireUuid(item['version_id']),sha256:item['sha256'],size:item['size']};
}
/** Always authenticates a fixed read, even when identical bytes are already local. */
export async function downloadFixed(api:HubApiClient,reference:FixedReference,directory:string,
 options:{signal?:AbortSignal;chunkBytes?:number}={}):Promise<{state:'verified';path:string;fixed_ref:FixedReference;read_receipt_id:string|null;authorization_window:'before_full_stream'|'per_requested_chunk';downloaded_bytes_recalled:false}>{
 const ref=fixedReference(reference),root=await controlledDirectory(directory),temporaryDirectory=await mkdtemp(join(root,'.download-'));
 const temporary=join(temporaryDirectory,'bytes'),target=join(root,`${ref.material_id}_${ref.version_id}_${ref.sha256}.bin`);
 let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;let file;
 try{
  file=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  const hash=createHash('sha256');let size=0,receipt:string|null=null;
  const write=async(bytes:Uint8Array)=>{
   size+=bytes.byteLength;if(size>ref.size)throw new ConsumerError('fixed_size_mismatch',0,true);hash.update(bytes);
   let offset=0;while(offset<bytes.byteLength){const wrote=await file!.write(bytes,offset,bytes.byteLength-offset);if(!wrote.bytesWritten)throw new ConsumerError('local_write_failed');offset+=wrote.bytesWritten;}
  };
  const requestOptions={expectedBinding:await api.bindingId(),...(options.signal?{signal:options.signal}:{})};
  if(options.chunkBytes!==undefined){
   if(!Number.isSafeInteger(options.chunkBytes)||options.chunkBytes<1||options.chunkBytes>131072)throw new ConsumerError('invalid_chunk_budget');
   let position=0;
   do{
    const result=await api.postJson<Record<string,unknown>>('/v2/files/read-chunk',{project_id:ref.project_id,material_id:ref.material_id,version_id:ref.version_id,offset:position,limit:options.chunkBytes,encoding:'base64'},requestOptions);
    const fixed=result['fixed_ref'] as Record<string,unknown>|undefined,range=result['range'] as Record<string,unknown>|undefined;
    if(!fixed||fixed['material_id']!==ref.material_id||fixed['version_id']!==ref.version_id||fixed['sha256']!==ref.sha256||fixed['size']!==ref.size||
      !range||range['start']!==position||typeof range['end_exclusive']!=='number'||!Number.isSafeInteger(range['end_exclusive'])||range['end_exclusive']<position||range['end_exclusive']>ref.size||typeof result['bytes_base64']!=='string')
     throw new ConsumerError('fixed_chunk_contract_mismatch',0,true);
    const bytes=Buffer.from(result['bytes_base64'],'base64');
    if(bytes.byteLength!==range['end_exclusive']-position||bytes.byteLength>options.chunkBytes||bytes.toString('base64')!==result['bytes_base64']||createHash('sha256').update(bytes).digest('hex')!==result['chunk_sha256'])
     throw new ConsumerError('fixed_chunk_integrity_mismatch',0,true);
    const next=range['end_exclusive'];
    if((next<ref.size&&(next===position||result['next_offset']!==next))||(next===ref.size&&result['next_offset']!==null))throw new ConsumerError('fixed_chunk_progress_mismatch',0,true);
    await write(bytes);position=next;
    const evidence=result['read_receipt'] as {id?:unknown}|undefined;if(typeof evidence?.id==='string')receipt=evidence.id;
   }while(position<ref.size);
  }else{
   const response=await api.postStream('/v2/files/read',{project_id:ref.project_id,material_id:ref.material_id,version_id:ref.version_id},requestOptions);
   if(!response.body)throw new ConsumerError('file_body_missing',0,true);
   reader=response.body.getReader();for(;;){const next=await reader.read();if(next.done)break;await write(next.value);}
   receipt=response.headers.get('x-hub-read-receipt');
  }
  if(size!==ref.size)throw new ConsumerError('fixed_size_mismatch',0,true);
  if(hash.digest('hex')!==ref.sha256)throw new ConsumerError('fixed_hash_mismatch',0,true);
  await file.sync();await file.close();file=undefined;
  await rename(temporary,target);
  return {state:'verified',path:target,fixed_ref:ref,read_receipt_id:receipt&&/^[a-f0-9-]{36}$/i.test(receipt)?receipt:null,
   authorization_window:options.chunkBytes===undefined?'before_full_stream':'per_requested_chunk',downloaded_bytes_recalled:false};
 }catch(error){await reader?.cancel().catch(()=>{});if(error instanceof ConsumerError)throw error;throw new ConsumerError('fixed_download_incomplete',0,true);}
 finally{reader?.releaseLock();await file?.close().catch(()=>{});await rm(temporaryDirectory,{recursive:true,force:true});}
}

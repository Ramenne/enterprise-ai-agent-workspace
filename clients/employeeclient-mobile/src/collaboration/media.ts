import {streamDownload} from '@/native/download-stream.mjs';
import type {ChatAttachment} from '@/api/types';
import {isNativeFileUrl} from '@/files/native-url';
import type {UploadSource} from '@/files/multipart';
import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';
import {beginLargeBlob,cachedBlob,storeBlob,removeBlob,attachmentKey,cacheLease,resolveAttachmentKey,rememberAttachmentAlias} from '@/platform/attachmentCache';
import {runCommand} from './commands';
import {prepareBrowserSave,type BrowserSaveTarget,type SaveReceipt} from '@/platform/saveFile';
import {Capacitor,registerPlugin,type PluginListenerHandle} from '@capacitor/core';
export type Attachment={id:string;name:string;mime:string;kind:'image'|'audio'|'video'|'file';size?:number;version?:string;sha256?:string;url?:string;resolveUrl?:(signal:AbortSignal)=>Promise<string>;unavailable?:string;rename?:(name:string)=>Promise<void>;groupAttachment?:ChatAttachment};
// A digest is a content revision even when a provider reuses its version label.
export function attachmentRevision(a:Attachment){const version=a.version||'',sha=a.sha256||'';return sha&&!version.includes(sha)?`${version}:${sha}`:version;}
export type MediaContext={computer:string;provider:string;thread:string;account:string};
export function sourceIdentity(a:Attachment,c:MediaContext){return [c.account,c.computer,c.provider,c.thread,a.id,attachmentRevision(a)];}
export const native=registerPlugin<{
 addListener(name:'progress',callback:(data:{id:string;loaded:number;total?:number})=>void):Promise<PluginListenerHandle>;
 audioDuration(options:{id:string}):Promise<{seconds:number}>;
 readPart(options:{id:string;offset:number;length:number}):Promise<{data:string;size:number}>;
 fetch(options:{id:string;url:string;expectedSize?:number}):Promise<{size:number}>;
 lookup(options:{key:string;sha256?:string}):Promise<{found:boolean;id:string;name:string;url:string;size:number;saved:boolean;location:string}>;
 rename(options:{id:string;name:string}):Promise<{name:string;url:string}>;
 release(options:{id:string}):Promise<void>;
 share(options:{id:string}):Promise<void>;
 begin(options:{name:string;mime:string;key:string}):Promise<{id:string}>;
 append(options:{id:string;data:string;offset:number}):Promise<void>;
 finish(options:{id:string;size:number;sha256?:string}):Promise<{url:string}>;
 save(options:{id:string;repeat?:boolean;name?:string}):Promise<{saved:boolean;name:string;location:string;size:number;sha256:string}>;
 open(options:{id:string}):Promise<void>;
 remove(options:{id:string}):Promise<void>;
}>('EmployeeClientAttachment');
export type LoadedMedia={audioDuration?:()=>Promise<number>;cacheAs?:(a:Attachment,ctx:MediaContext)=>Promise<void>;uploadSource:UploadSource;url:string;blob?:Blob;cached?:boolean;localName?:string;rename?:(name:string)=>Promise<void>;saved?:boolean;location?:string;share:()=>Promise<void>;save:(target?:BrowserSaveTarget,options?:{repeat?:boolean;name?:string})=>Promise<SaveReceipt>;open:(target?:BrowserSaveTarget)=>Promise<void|SaveReceipt>;dispose:()=>void};
export function safeRemote(url:string){const u=new URL(url);if(!['https:','http:'].includes(u.protocol)||u.username||u.password)throw Error('附件地址无效');return u.href;}
async function nativeMedia(id:string,url:string,size:number,saved=false,location='',name=''):Promise<LoadedMedia>{
 const value:LoadedMedia={cached:true,audioDuration:async()=>{const r=await native.audioDuration({id});return r.seconds;},uploadSource:{size,readPart:async(start,end)=>{if(start<0||end>size||end-start>16*1024**2)throw Error('文件读取范围无效');const chunks:Uint8Array<ArrayBuffer>[]=[];for(let offset=start;offset<end;offset+=524288){const length=Math.min(524288,end-offset),r=await native.readPart({id,offset,length});if(r.size!==size)throw Error('本机文件已变化');const bytes=Uint8Array.from(atob(r.data),c=>c.charCodeAt(0));if(bytes.length!==length)throw Error('本机文件读取不完整');chunks.push(bytes);}return new Blob(chunks);}},url:Capacitor.convertFileSrc(url),saved,location,localName:name,rename:async(name)=>{const r=await native.rename({id,name});value.localName=r.name;value.url=Capacitor.convertFileSrc(r.url);},save:async(_target,options)=>{const r=await native.save({id,...options});if(!r.saved||r.size!==size||!/^[a-f0-9]{64}$/.test(r.sha256))throw Error('未收到完整保存结果，请检查下载文件');value.saved=true;value.location=r.location;return {state:'saved',message:`已保存到${r.location}：${r.name}`};},open:()=>native.open({id}),share:()=>native.share({id}),dispose:()=>{void native.release({id}).catch(()=>{});}};return value;
}
function browserMedia(a:Attachment,blob:Blob,cached=true):LoadedMedia{
 const url=URL.createObjectURL(blob);
 const value:LoadedMedia={uploadSource:blob,url,blob,cached,localName:a.name,
  save:async(target?:BrowserSaveTarget)=>{const receipt=await(target||await prepareBrowserSave(a.name)).save(blob);if(receipt.state==='saved'){value.saved=true;value.location='本机所选位置';}return receipt;},
  open:async()=>{const w=window.open(url,'_blank');if(!w)throw Error('请允许打开文件预览');w.opener=null;},
  share:async()=>{const files=[new File([blob],a.name,{type:a.mime})];if(!navigator.canShare?.({files}))throw Error('当前浏览器不支持文件分享，请先下载到本机');await navigator.share({files});},
  dispose:()=>URL.revokeObjectURL(url)};
 return value;
}
function withIdentity(media:LoadedMedia,key:string,account:string,valid=cacheLease(account)){media.cacheAs=async(a,ctx)=>{if(!media.cached||ctx.account!==account||!valid())return;const next=await attachmentKey(sourceIdentity(a,ctx));if(valid())rememberAttachmentAlias(key,next);};return media;}
const uploadedRetention=new Map<string,Promise<boolean>>();
export function retainUploadedAttachment(a:Attachment,ctx:MediaContext,source:UploadSource,signal:AbortSignal){
 const id=JSON.stringify(sourceIdentity(a,ctx)),prior=uploadedRetention.get(id);if(prior)return prior;
 const work=retainLocalAttachment(a,ctx,source,signal).catch(()=>false).finally(()=>{if(uploadedRetention.get(id)===work)uploadedRetention.delete(id);});uploadedRetention.set(id,work);return work;
}
const cacheChecks=new Map<string,Promise<Blob|undefined>>();
async function verifiedBrowserBlob(key:string,a:Attachment,valid:()=>boolean){
 const id=JSON.stringify([key,a.size,a.sha256]);const previous=cacheChecks.get(id);if(previous)return previous;
 const work=(async()=>{
  const blob=await cachedBlob(key);if(!blob||!valid())return undefined;
  let good=a.size===undefined||blob.size===a.size;
  if(good&&a.sha256){const hash=sha256.create();for(let start=0;start<blob.size;start+=1048576){if(!valid())return undefined;hash.update(new Uint8Array(await blob.slice(start,Math.min(blob.size,start+1048576)).arrayBuffer()));}good=bytesToHex(hash.digest())===a.sha256;}
  if(!valid())return undefined;
  if(!good){await removeBlob(key);return undefined;}return blob;
 })();cacheChecks.set(id,work);
 try{return await work;}finally{if(cacheChecks.get(id)===work)cacheChecks.delete(id);}
}
export async function findAttachment(a:Attachment,ctx:MediaContext,fromUpload=false):Promise<LoadedMedia|undefined>{
 const valid=cacheLease(ctx.account);
 if(!fromUpload)await uploadedRetention.get(JSON.stringify(sourceIdentity(a,ctx)));
 if(!valid())return undefined;
 const canonical=await attachmentKey(sourceIdentity(a,ctx));
 // V59 included size in the cache key. Probe it once so an upgrade does not
 // force a second download of a previously verified file.
 const legacy=await attachmentKey([...sourceIdentity(a,ctx),a.size]);
 const oldUnknownSize=a.size===undefined?legacy:await attachmentKey([...sourceIdentity(a,ctx),undefined]);
 for(const raw of [...new Set([canonical,legacy,oldUnknownSize])]){
  // A shared group's source alias can expire while its own verified copy remains.
  // Probe the source first for reuse, then the group's canonical key before downloading.
  const resolved=resolveAttachmentKey(raw);
  for(const key of resolved===raw?[raw]:[resolved,raw]){
   if(Capacitor.isNativePlatform()){
    const r=await native.lookup({key,sha256:a.sha256});
    if(!valid())return undefined;
    if(!r.found)continue;
    if(a.size!==undefined&&r.size!==a.size){await native.remove({id:r.id});continue;}
    if(raw!==canonical)rememberAttachmentAlias(key,canonical);
    const media=await nativeMedia(r.id,r.url,r.size,r.saved,r.location,r.name);if(!valid()){media.dispose();return undefined;}
    return withIdentity(media,key,ctx.account,valid);
   }
   const blob=await verifiedBrowserBlob(key,a,valid);
   if(!valid())return undefined;
   if(!blob)continue;
   if(raw!==canonical)rememberAttachmentAlias(key,canonical);
   return withIdentity(browserMedia(a,blob),key,ctx.account,valid);
  }
 }
}
export async function loadAttachment(a:Attachment,ctx:MediaContext,signal:AbortSignal,progress:(loaded:number,total?:number)=>void,localSource?:UploadSource):Promise<LoadedMedia>{
 const lease=cacheLease(ctx.account);
 const cached=await findAttachment(a,ctx,!!localSource);if(signal.aborted||!lease()){cached?.dispose();throw new DOMException('已取消','AbortError');}if(cached)return cached;
 if(a.unavailable)throw Error(a.unavailable);
 const key=await attachmentKey(sourceIdentity(a,ctx));
 if(!localSource&&a.resolveUrl)a={...a,url:await a.resolveUrl(signal)};
 let disk:Awaited<ReturnType<typeof beginLargeBlob>>|undefined;
 let nativeId='',url='';
 const hash=sha256.create();const chunks:Uint8Array<ArrayBuffer>[]=[];let loaded=0;let listener:PluginListenerHandle|undefined;
 const cancelNative=()=>{if(nativeId)void native.remove({id:nativeId}).catch(()=>{});};
 signal.addEventListener('abort',cancelNative,{once:true});
 const check=()=>{if(signal.aborted||!lease())throw new DOMException('已取消','AbortError');};
 const asBase64=(bytes:Uint8Array)=>{let s='';for(let i=0;i<bytes.length;i+=32768)s+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(s);};
 const append=async(bytes:Uint8Array<ArrayBuffer>)=>{
  if(loaded+bytes.byteLength>100*1024**3||a.size!==undefined&&loaded+bytes.byteLength>a.size)throw Error('附件长度超出声明范围，已停止读取');
  if(!nativeId&&!disk&&loaded+bytes.byteLength>64*1024**2){disk=await beginLargeBlob(key,()=>lease()&&!signal.aborted);for(const part of chunks)await disk.append(part);chunks.length=0;}
  check();if(nativeId)await native.append({id:nativeId,data:asBase64(bytes),offset:loaded});else {hash.update(bytes);if(disk)await disk.append(bytes);else chunks.push(bytes);}
  loaded+=bytes.byteLength;
 };
 try{
  check();if(Capacitor.isNativePlatform())nativeId=(await native.begin({name:a.name,mime:a.mime,key})).id;
  if(localSource){
   if(a.size!==undefined&&localSource.size!==a.size)throw Error('本机文件长度已变化');
   for(let offset=0;offset<localSource.size;offset+=524288){
    check();const end=Math.min(localSource.size,offset+524288);
    const part=localSource.readPart?await localSource.readPart(offset,end):localSource.slice!(offset,end);
    check();if(part.size!==end-offset)throw Error('本机文件读取不完整');
    await append(new Uint8Array(await part.arrayBuffer()));progress(loaded,localSource.size);
   }
  }else if(a.url&&nativeId){
   listener=await native.addListener('progress',data=>{if(data.id===nativeId&&!signal.aborted)progress(data.loaded,data.total);});
   check();loaded=(await native.fetch({id:nativeId,url:safeRemote(a.url),expectedSize:a.size})).size;
   progress(loaded,loaded);
  }else if(a.url){
   await streamDownload(safeRemote(a.url),{signal,credentials:isNativeFileUrl(a.url)?'include':'omit',onChunk:async(bytes:Uint8Array,total?:number)=>{
    check();for(let i=0;i<bytes.length;i+=524288)await append(bytes.slice(i,i+524288));progress(loaded,total);
   }});
  }else{
   let size=a.size;
   do{
    check();const r=await runCommand(ctx.computer,{provider:ctx.provider,operation:'attachment',thread_id:ctx.thread,attachment_id:a.id,offset:loaded},signal);
    if(r.id!==a.id||r.offset!==loaded||!Number.isSafeInteger(r.size)||r.size<loaded||(size!==undefined&&size!==r.size))throw Error('附件已变化，请刷新会话后重试');
    size=r.size;const bytes=Uint8Array.from(atob(r.data),c=>c.charCodeAt(0));
    const sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
    if(sha!==r.sha256||r.next_offset!==loaded+bytes.length||r.next_offset>r.size||r.eof!==(r.next_offset===r.size)||(!bytes.length&&!r.eof))throw Error('附件校验失败，请重新下载');
    await append(bytes);progress(loaded,size);if(r.eof)break;
   }while(true);
  }
  check();if(a.size!==undefined&&loaded!==a.size)throw Error('附件长度校验失败，请重试');
  if(nativeId){
   url=(await native.finish({id:nativeId,size:loaded,sha256:a.sha256})).url;
   const id=nativeId;check();
   const media=await nativeMedia(id,url,loaded,false,'',a.name);if(!lease()){media.dispose();check();}
   return withIdentity(media,key,ctx.account,lease);
  }
  if(a.sha256&&bytesToHex(hash.digest())!==a.sha256)throw Error('附件完整性校验失败，请重试');
  if(disk){const blob=await disk.finish(a.mime,loaded);check();return withIdentity(browserMedia(a,blob,true),key,ctx.account,lease);}
  const blob=new Blob(chunks,{type:a.mime});const cached=await storeBlob(key,blob,lease);check();
  return withIdentity(browserMedia(a,blob,cached),key,ctx.account,lease);
 }catch(e){await disk?.cancel().catch(()=>{});if(nativeId)void native.remove({id:nativeId}).catch(()=>{});if(url)URL.revokeObjectURL(url);throw e;}
 finally{signal.removeEventListener('abort',cancelNative);await listener?.remove();}
}

// Local originals and verified saves enter the same cache as acquired files.
// No URL resolution, remote request or second upload is used to retain them.
export async function retainLocalAttachment(a:Attachment,ctx:MediaContext,source:UploadSource,signal:AbortSignal){

 const media=await loadAttachment(a,ctx,signal,()=>{},source);
 try{return media.cached===true;}finally{media.dispose();}
}

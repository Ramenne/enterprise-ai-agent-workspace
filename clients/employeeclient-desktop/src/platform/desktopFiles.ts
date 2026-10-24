import {reactive} from 'vue';
import {desktopBridge} from './desktop';
import {captureApiLease} from '@/api/client';
import {findAttachment,sourceIdentity,type Attachment,type MediaContext} from '@/collaboration/media';
import {saveRemoteAttachment} from '@/files/download';
import {consumeDownloadStream} from '@/native/download-stream.mjs';
import {cacheLease} from './attachmentCache';
const copies=reactive(new Map<string,string>()),flights=new Map<string,Promise<string|undefined>>(),controllers=new Map<string,AbortController>();
const keyOf=(a:Attachment,c:MediaContext)=>JSON.stringify([...sourceIdentity(a,c),a.name]);
let account='',turn=0,accountFlight=Promise.resolve();
export function setDesktopFileAccount(value:string){
 if(value===account)return accountFlight;account=value;turn++;for(const c of controllers.values())c.abort();controllers.clear();copies.clear();flights.clear();
 accountFlight=accountFlight.catch(()=>{}).then(async()=>{await desktopBridge()?.fileAccount?.(value);});return accountFlight;
}
export function preparedDesktopFile(a:Attachment,c:MediaContext){return c.account===account?copies.get(keyOf(a,c)):undefined;}
export function invalidateDesktopFile(id:string){for(const [k,v]of copies)if(v===id)copies.delete(k);}
export async function prepareDesktopFile(a:Attachment,c:MediaContext,source:(signal:AbortSignal)=>Promise<Attachment>,cachedOnly=false):Promise<string|undefined>{
 const bridge=desktopBridge();if(!bridge?.fileBegin||!bridge.filePart||!bridge.fileFinish||!bridge.fileCancel)throw Error('请更新员工客户端电脑版后重试');
 const lease=captureApiLease(),validCache=cacheLease(c.account);const valid=()=>lease.valid()&&lease.account===c.account&&validCache()&&account===c.account;
 if(lease.account!==c.account||!lease.valid())throw new DOMException('文件身份已变化','AbortError');
 await setDesktopFileAccount(c.account);const version=turn,key=keyOf(a,c);const prior=flights.get(key);if(prior){const id=await prior;if(id||cachedOnly)return id;}
 const check=()=>{if(!valid()||version!==turn)throw new DOMException('文件操作已取消','AbortError');};
 const work=(async()=>{let held:Awaited<ReturnType<typeof findAttachment>>,id:string|undefined;const controller=new AbortController();controllers.set(key,controller);
 try{
  check();held=await findAttachment(a,c);check();if(cachedOnly&&!held)return undefined;
  if(!Number.isSafeInteger(a.size)||a.size!<0||!/^[a-f0-9]{64}$/.test(a.sha256||''))throw Error('原文件版本信息尚未就绪，请重新获取');
  const begun=await bridge.fileBegin!({account:c.account,key,name:a.name,size:a.size!,sha256:a.sha256!});id=begun.id;check();
  if(!begun.complete){let offset=0;
   const stream=async(value:ReadableStream<Uint8Array>)=>{await consumeDownloadStream(value,{signal:controller.signal,onChunk:async(bytes:Uint8Array)=>{check();for(let at=0;at<bytes.length;at+=8*1024**2){const part=bytes.slice(at,at+8*1024**2);const next=await bridge.filePart!(id!,offset,part);check();if(next!==offset+part.length)throw Error('文件副本写入不完整');offset=next;}}});check();await bridge.fileFinish!(id!);check();return {state:'saved' as const,message:'文件已准备好'};};
   if(held){const s=held.uploadSource;let at=0;await stream(new ReadableStream<Uint8Array>({async pull(ctl){try{check();if(at>=s.size){ctl.close();return;}const end=Math.min(s.size,at+8*1024**2),blob=s.readPart?await s.readPart(at,end):s.slice?.(at,end);if(!blob)throw Error('本机文件暂不可读');const bytes=new Uint8Array(await blob.arrayBuffer());if(bytes.length!==end-at)throw Error('本机文件读取不完整');at=end;ctl.enqueue(bytes);}catch(e){ctl.error(e);}}}));}
   else await saveRemoteAttachment(await source(controller.signal),c,{cancel:()=>controller.abort(),save:blob=>stream(blob.stream()),saveStream:(value)=>stream(value)},controller.signal,valid);
  }
  check();copies.set(key,id!);return id;
 }catch(e){if(id)await bridge.fileCancel!(id).catch(()=>{});throw e;}finally{held?.dispose();if(controllers.get(key)===controller)controllers.delete(key);}
 })();flights.set(key,work);try{return await work;}finally{if(flights.get(key)===work)flights.delete(key);}
}
export async function desktopFileAction(kind:'open'|'share',a:Attachment,c:MediaContext,source:(signal:AbortSignal)=>Promise<Attachment>){
 const id=await prepareDesktopFile(a,c,source);if(!id)throw Error('文件尚未准备好');const bridge=desktopBridge();
 try{return await(kind==='open'?bridge?.fileOpen?.(id):bridge?.fileShare?.(id));}catch(e){invalidateDesktopFile(id);throw e;}
}
export function dragDesktopFile(event:DragEvent,a:Attachment,c:MediaContext){const id=preparedDesktopFile(a,c);event.preventDefault();if(id)desktopBridge()?.fileDrag?.(id);}

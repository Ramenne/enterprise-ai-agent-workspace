/** Browser saving and native saving have different acknowledgement guarantees. */
import {desktopBridge,isDesktopNative} from './desktop';
import {sha256} from '@noble/hashes/sha2.js';
import {consumeDownloadStream} from '@/native/download-stream.mjs';
export type SaveReceipt={state:'saved'|'handed_off';message:string};
type WritableFile={write(data:Blob|Uint8Array):Promise<void>;close():Promise<void>;abort():Promise<void>};
type FileHandle={name:string;createWritable():Promise<WritableFile>;getFile():Promise<File>};
export type BrowserSaveTarget={save(blob:Blob):Promise<SaveReceipt>;saveStream?:(stream:ReadableStream<Uint8Array>,expected:{size:number;sha256:string},valid:()=>boolean,signal:AbortSignal)=>Promise<SaveReceipt>;saveURL?:(url:string)=>Promise<SaveReceipt>;readSaved?:()=>Promise<File|undefined>;cancel():void};
type SaveWindow=Window&{showSaveFilePicker?:(options:{suggestedName:string})=>Promise<FileHandle>};
export function isSaveCancelled(error:unknown){return error instanceof DOMException&&error.name==='AbortError'||!!error&&typeof error==='object'&&'code' in error&&error.code==='SAVE_CANCELLED';}
const cancelled=()=>new DOMException('已取消保存','AbortError');
const digest=async(blob:Blob,check=()=>{})=>{check();const hash=sha256.create(),reader=blob.stream().getReader();try{for(;;){const part=await reader.read();check();if(part.done)break;hash.update(part.value);}}finally{reader.releaseLock();}check();return hash.digest();};
/** Call synchronously from the click, before loading the source file. */
export async function prepareBrowserSave(name:string):Promise<BrowserSaveTarget>{
 const bridge=desktopBridge();
 if(bridge){
  if(!bridge.saveBegin||!bridge.savePart||!bridge.saveFinish||!bridge.saveCancel)throw Error('请更新员工客户端电脑版后保存');
  const id=await bridge.saveBegin(name);if(!id)throw cancelled();let stopped=false,completed=false;
  const cancel=()=>{if(!completed){stopped=true;void bridge.saveCancel!(id);}};
  const saveStream=async(stream:ReadableStream<Uint8Array>,expected:{size:number;sha256:string},valid:()=>boolean,signal:AbortSignal):Promise<SaveReceipt>=>{
   const check=()=>{if(stopped||signal.aborted||!valid())throw cancelled();};let offset=0;const hash=sha256.create();
   try{await consumeDownloadStream(stream,{signal,onChunk:async(bytes:Uint8Array)=>{check();if(offset+bytes.length>expected.size)throw Error('下载超过原件长度');for(let start=0;start<bytes.length;start+=8*1024**2){check();const part=bytes.slice(start,start+8*1024**2);const next=await bridge.savePart!(id,offset,part);if(next!==offset+part.length)throw Error('保存写入不完整');offset=next;hash.update(part);}}});check();if(offset!==expected.size||Array.from(hash.digest(),b=>b.toString(16).padStart(2,'0')).join('')!==expected.sha256)throw Error('下载内容校验失败');const result=await bridge.saveFinish!(id,expected.size,expected.sha256);completed=true;check();return result;}catch(error){cancel();throw error;}
  };
  return {cancel,saveStream,async save(blob){const digestBytes=await digest(blob);return saveStream(blob.stream(),{size:blob.size,sha256:Array.from(digestBytes,b=>b.toString(16).padStart(2,'0')).join('')},()=>!stopped,new AbortController().signal);}};
 }
 const picker=(window as SaveWindow).showSaveFilePicker;
 if(picker){
  const handle=await picker.call(window,{suggestedName:name});let stopped=false;const cancellation=new AbortController();
  const active=()=>{if(stopped)throw cancelled();};
  return {cancel(){stopped=true;cancellation.abort(cancelled());},readSaved:async()=>stopped?undefined:handle.getFile(),async save(blob){
   if(stopped)throw cancelled();const output=await handle.createWritable();
   try{active();await output.write(blob);active();await output.close();active();}
   catch(error){await output.abort().catch(()=>{});throw error;}
   const saved=await handle.getFile();active();
   if(saved.size!==blob.size)throw Error('保存结果不完整，请重试');
   const [expected,actual]=await Promise.all([digest(blob,active),digest(saved,active)]);active();
   if(!expected.every((byte,i)=>byte===actual[i]))throw Error('保存结果校验失败，请重试');
   return {state:'saved',message:`已保存 ${handle.name}`};
  },async saveStream(stream,expected,valid,signal){
   const check=()=>{if(stopped||signal.aborted||!valid())throw cancelled();};
   check();const output=await handle.createWritable(),hash=sha256.create();let count=0,closed=false;
   const combined=AbortSignal.any([signal,cancellation.signal]);
   try{
    check();await consumeDownloadStream(stream,{signal:combined,onChunk:async(bytes:Uint8Array)=>{check();count+=bytes.byteLength;if(count>expected.size)throw Error('下载超过原件长度，保存已停止');hash.update(bytes);await output.write(bytes);check();}});
    if(count!==expected.size||Array.from(hash.digest(),b=>b.toString(16).padStart(2,'0')).join('')!==expected.sha256)throw Error('下载内容校验失败，文件未保存');
    check();await output.close();closed=true;check();const saved=await handle.getFile();
    if(saved.size!==expected.size||Array.from(await digest(saved,check),b=>b.toString(16).padStart(2,'0')).join('')!==expected.sha256)throw Error('设备保存结果校验失败，请重试');
    check();return {state:'saved',message:`已保存 ${handle.name}`};
   }catch(error){if(!closed)await output.abort().catch(()=>{});throw error;}
  }};
 }
 const ios=/iP(?:ad|hone|od)/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
 // Safari cannot acknowledge a filesystem write. Reserve its preview while the
 // user gesture is active; navigating an async blob later must not be blocked.
 const preview=ios?window.open('about:blank','_blank'):null;
 if(ios&&!preview)throw Error('请允许打开文件预览后重试');
 if(preview){preview.opener=null;preview.document.title='正在准备文件';preview.document.body.textContent='正在准备文件…';}
 let stopped=false;
 const handoff=(url:string)=>{if(stopped||preview?.closed)throw cancelled();if(preview){preview.location.replace(url);return {state:'handed_off' as const,message:'已交给系统文件窗口，请确认保存'};}const link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();return {state:'handed_off' as const,message:isDesktopNative()?'已交给系统保存窗口，请确认保存':'已交给浏览器下载，可在下载列表查看'};};
 return {cancel(){stopped=true;preview?.close();},async saveURL(url){const fixed=new URL(url);fixed.searchParams.set('name',name);return handoff(fixed.href);},async save(blob){
  if(stopped||preview?.closed)throw cancelled();
  const url=URL.createObjectURL(blob);
  // Keep the URL available after a route change until the browser has consumed it.
  setTimeout(()=>URL.revokeObjectURL(url),120000);
  return handoff(url);
 }};
}

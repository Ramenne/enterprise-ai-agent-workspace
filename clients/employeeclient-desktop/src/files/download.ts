import type {Attachment,MediaContext} from '@/collaboration/media';
import {loadAttachment,safeRemote} from '@/collaboration/media';
import {isNativeFileUrl} from './native-url';
import type {BrowserSaveTarget,SaveReceipt} from '@/platform/saveFile';
import {fetchDownloadResponse} from '@/native/download-stream.mjs';

// Saving owns its transfer. Durable preview caching is optional, not a gate.
export async function saveRemoteAttachment(a:Attachment,c:MediaContext,target:BrowserSaveTarget,signal:AbortSignal,valid:()=>boolean):Promise<SaveReceipt>{
 const check=()=>{if(signal.aborted||!valid())throw new DOMException('保存已取消或账号已变化','AbortError');};
 check();if(a.unavailable)throw Error(a.unavailable);
 const url=a.url||await a.resolveUrl?.(signal);check();
 const exact=Number.isSafeInteger(a.size)&&a.size!>=0&&/^[a-f0-9]{64}$/.test(a.sha256||'');
 if(url&&exact&&target.saveStream){
  const response=await fetchDownloadResponse(safeRemote(url),{signal,credentials:isNativeFileUrl(url)?'include':'omit'});
  try{check();}catch(error){void response.body?.cancel().catch(()=>{});throw error;}
  if(!response.ok||!response.body){void response.body?.cancel().catch(()=>{});const messages:Record<number,string>={401:'登录已失效，请重新登录后下载',403:'当前账号没有读取这份文件的权限',404:'文件原件未找到',409:'原件暂不可读，请稍后重试'};throw Error(messages[response.status]||`文件服务暂不可用（HTTP ${response.status}）`);}
  try{return await target.saveStream(response.body,{size:a.size!,sha256:a.sha256!},valid,signal);}finally{void response.body.cancel().catch(()=>{});}
 }
 // iPhone/Safari and browsers without a filesystem writer can hand an exact
 // same-origin, authenticated fixed reference to their system download flow.
 // No token or signed credential is included in the URL or client storage.
 if(url&&exact&&isNativeFileUrl(url)&&target.saveURL){check();return target.saveURL(safeRemote(url));}
 const media=await loadAttachment({...a,...(url?{url,resolveUrl:undefined}:{})},c,signal,()=>{});
 try{check();return await media.save(target);}finally{media.dispose();}
}

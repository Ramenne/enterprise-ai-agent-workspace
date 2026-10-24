import {findAttachment,retainLocalAttachment,type Attachment,type MediaContext,type LoadedMedia} from '@/collaboration/media';
import {acquisitionKey,startAcquisition,type AcquisitionJob} from './acquisition';
import {prepareBrowserSave,type BrowserSaveTarget} from '@/platform/saveFile';
import {Capacitor} from '@capacitor/core';
import {cacheLease} from '@/platform/attachmentCache';
import {saveRemoteAttachment} from './download';
import {captureApiLease} from '@/api/client';

export type LocalSaveJob={key:string;account:string;state:'running'|'complete'|'handed_off'|'error';stage:string;message?:string;error?:string;promise:Promise<LocalSaveJob>};
const jobs=new Map<string,LocalSaveJob>();
const targets=new Map<string,BrowserSaveTarget>();
const preparing=new Map<string,{account:string;promise:Promise<LocalSaveJob>}>();
const controllers=new Map<string,AbortController>();
const handoffPrefix='qn.local-save-handoff:';
export const LOCAL_SAVE_CHANGED='qn:local-file-save';
function changed(job:LocalSaveJob){window.dispatchEvent(new CustomEvent(LOCAL_SAVE_CHANGED,{detail:job}));}
function restoredHandoff(key:string,account:string):LocalSaveJob|undefined{
 if(Capacitor.isNativePlatform())return;
 try{
  if(localStorage.getItem(handoffPrefix+key)!=='1')return;
  const job:LocalSaveJob={key,account,state:'handed_off',stage:'已交给浏览器，请在下载列表确认',message:'已交给浏览器，请在下载列表确认',promise:undefined!};
  job.promise=Promise.resolve(job);jobs.set(key,job);return job;
 }catch{return;}
}
export function getLocalSave(a:Attachment,c:MediaContext){const key=acquisitionKey(a,c);return jobs.get(key)||restoredHandoff(key,c.account);}
// Android can verify whether its previous system save still exists. A cached
// completion must not hide Download again after that file was removed.
export function reconcileLocalSave(a:Attachment,c:MediaContext,verified?:LoadedMedia){
 const key=acquisitionKey(a,c),job=getLocalSave(a,c);
 if(Capacitor.isNativePlatform()&&verified&&!verified.saved&&job?.state==='complete'){
  jobs.delete(key);return undefined;
 }
 return job;
}

export async function startLocalSave(a:Attachment,c:MediaContext,name:string,source:(signal:AbortSignal)=>Promise<Attachment>,acquiring?:AcquisitionJob,repeat=false):Promise<LocalSaveJob>{
 const cacheValid=cacheLease(c.account),lease=captureApiLease();
 const valid=()=>cacheValid()&&lease.account===c.account&&lease.valid();
 if(!valid())throw new DOMException('保存身份尚未确认','AbortError');
 const key=acquisitionKey(a,c),previous=getLocalSave(a,c);
 if(previous&&(previous.state==='running'||(!repeat&&['complete','handed_off'].includes(previous.state))))return previous;
 const pending=preparing.get(key);if(pending)return pending.promise;
 const preparation={account:c.account,promise:undefined! as Promise<LocalSaveJob>};
 // Reserve the browser's save destination during the user's click, before any
 // network wait. The handle and the transfer then outlive the message card.
 const targetPromise:Promise<BrowserSaveTarget|undefined>=Capacitor.isNativePlatform()?Promise.resolve(undefined):prepareBrowserSave(name);
 const ready=(async()=>{
 const target=await targetPromise;
 if(!valid()||preparing.get(key)!==preparation){target?.cancel();throw new DOMException('保存已取消或账号已变化','AbortError');}
 const job:LocalSaveJob={key,account:c.account,state:'running',stage:'正在准备文件…',promise:undefined!};
 const controller=new AbortController();controllers.set(key,controller);
 const check=()=>{if(controller.signal.aborted||!valid()||jobs.get(key)!==job)throw new DOMException('保存已取消或账号已变化','AbortError');};
 jobs.set(key,job);if(target)targets.set(key,target);changed(job);
 job.promise=(async()=>{
  let media:Awaited<ReturnType<typeof findAttachment>>;
  try{
   media=await findAttachment(a,c);
   check();
   if(!Capacitor.isNativePlatform()&&!media){
    job.stage='正在下载到设备…';changed(job);
    const resolved=await source(controller.signal);check();
    const receipt=await saveRemoteAttachment(resolved,c,target!,controller.signal,valid);check();
    if(receipt.state==='saved'&&target?.readSaved){
     // Reuse the confirmed local file, never fetch its cloud URL again for share.
     try{const saved=await target.readSaved();check();if(saved)await retainLocalAttachment(a,c,saved,controller.signal);}catch{ /* Device save succeeded even if application cache is unavailable. */ }
     check();
    }
    job.state=receipt.state==='saved'?'complete':'handed_off';job.message=receipt.message;job.stage=receipt.message;
    try{if(job.state==='handed_off')localStorage.setItem(handoffPrefix+key,'1');else localStorage.removeItem(handoffPrefix+key);}catch{}
    changed(job);return job;
   }
   if(!media){await (acquiring||startAcquisition(a,c,source)).promise;check();media=await findAttachment(a,c);check();}
   if(!media)throw Error('文件暂不可读，请重新获取');
   job.stage='正在保存到设备…';changed(job);
   check();
   const receipt=await media.save(target,{repeat,name});check();
   job.state=receipt.state==='saved'?'complete':'handed_off';job.message=receipt.message;job.stage=receipt.message;
   try{if(job.state==='handed_off')localStorage.setItem(handoffPrefix+key,'1');else localStorage.removeItem(handoffPrefix+key);}catch{}
   changed(job);
   return job;
  }catch(e){target?.cancel();job.state='error';job.error=e instanceof Error?e.message:'保存失败';job.stage='';if(jobs.get(key)===job)changed(job);throw e;}
  finally{media?.dispose();if(targets.get(key)===target)targets.delete(key);if(controllers.get(key)===controller)controllers.delete(key);}
 })();
 return job;
 })();
 preparation.promise=ready;preparing.set(key,preparation);
 try{return await ready;}finally{if(preparing.get(key)===preparation)preparing.delete(key);}
}
export function clearLocalSaves(account:string){
 for(const [key,pending] of preparing)if(pending.account===account)preparing.delete(key);
 for(const [key,job] of jobs)if(job.account===account){controllers.get(key)?.abort();targets.get(key)?.cancel();jobs.delete(key);}
 try{for(const key of Object.keys(localStorage))if(key.startsWith(handoffPrefix)){
  const identity=JSON.parse(key.slice(handoffPrefix.length));
  if(Array.isArray(identity)&&identity[0]===account)localStorage.removeItem(key);
 }}catch{}
}

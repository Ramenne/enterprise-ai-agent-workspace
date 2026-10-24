import {sourceIdentity,findAttachment,loadAttachment,type Attachment,type MediaContext,type LoadedMedia} from '@/collaboration/media';

// The transfer belongs to the file, not to a message card. A route change may
// destroy the card, but it must not cancel bytes already being fetched.
export type AcquisitionJob={
 key:string;account:string;state:'running'|'complete'|'error'|'cancelled';
 loaded:number;total?:number;error?:string;promise:Promise<void>;cancel:()=>void;
};
const jobs=new Map<string,AcquisitionJob>();
export const ACQUISITION_CHANGED='qn:attachment-acquisition';
export const acquisitionKey=(a:Attachment,c:MediaContext)=>JSON.stringify(sourceIdentity(a,c));
export function getAcquisition(a:Attachment,c:MediaContext){return jobs.get(acquisitionKey(a,c));}
function changed(job:AcquisitionJob){window.dispatchEvent(new CustomEvent(ACQUISITION_CHANGED,{detail:job}));}

export function startAcquisition(a:Attachment,c:MediaContext,source:(signal:AbortSignal)=>Promise<Attachment>):AcquisitionJob{
 const key=acquisitionKey(a,c),previous=jobs.get(key);
 if(previous?.state==='running')return previous;
 const controller=new AbortController();
 const job:AcquisitionJob={key,account:c.account,state:'running',loaded:0,total:a.size,promise:undefined!,cancel:()=>controller.abort()};
 const check=()=>{if(controller.signal.aborted||jobs.get(key)!==job)throw new DOMException('已取消','AbortError');};
 jobs.set(key,job);
 job.promise=(async()=>{
  let media:LoadedMedia|undefined;
  try{
   media=await findAttachment(a,c);check();
   if(!media)media=await loadAttachment(await source(controller.signal),c,controller.signal,(loaded,total)=>{
    if(jobs.get(key)!==job)return;
    job.loaded=loaded;job.total=total||a.size;changed(job);
   });
   check();
   if(!media.cached)throw Error('文件已读取，但未能写入应用缓存；请检查设备存储空间后重试');
   await media.cacheAs?.(a,c);check();
   job.loaded=media.uploadSource.size;job.total=media.uploadSource.size;job.state='complete';changed(job);
  }catch(e){
   job.state=controller.signal.aborted?'cancelled':'error';
   job.error=job.state==='cancelled'?'已取消':e instanceof Error?e.message:'文件获取失败';
   changed(job);throw e;
  }finally{
   media?.dispose();
   if(jobs.size>48)for(const [oldKey,old] of jobs)if(old.state!=='running'&&oldKey!==key){jobs.delete(oldKey);if(jobs.size<=32)break;}
  }
 })();
 changed(job);return job;
}

export function clearAcquisitions(account:string){for(const [key,job] of jobs)if(job.account===account){job.cancel();jobs.delete(key);}}

import {saveCloudFile,renameCloudFile,verifyCloudContent,type CloudFile} from './cloud';
import {sourceIdentity,type Attachment,type MediaContext} from '@/collaboration/media';
import type {UploadSource} from './multipart';

// Transfer ownership belongs to the file workflow, not to a card in a virtualized
// conversation. A card can disappear during a source refresh while Mac keeps uploading.
export type CloudJob={
 key:string;account:string;state:'running'|'complete'|'error';stage:string;
 file?:CloudFile;error?:string;
 promise:Promise<CloudJob>;
};
const jobs=new Map<string,CloudJob>();
const controllers=new Map<string,AbortController>();
export const CLOUD_JOB_CHANGED='qn:cloud-job-changed';
const identity=(a:Attachment,c:MediaContext)=>JSON.stringify(sourceIdentity(a,c));
export const cloudJobKey=(a:Attachment,c:MediaContext,targetName=a.name)=>`${identity(a,c)}:personal:${targetName}`;
type PendingIntent={key:string;forward:boolean;targetName:string;createdAt:number;state:'running'|'error'};
const intentKey=(account:string)=>`qn.cloud-pending:${account}`;
function readIntents(account:string):PendingIntent[]{
 try{const value=JSON.parse(localStorage.getItem(intentKey(account))||'[]');return Array.isArray(value)?value.filter((item):item is PendingIntent=>typeof item?.key==='string'&&typeof item?.forward==='boolean'&&typeof item?.targetName==='string'&&Number.isSafeInteger(item?.createdAt)&&Date.now()-item.createdAt<7*86400000&&item.createdAt<=Date.now()).map(item=>({...item,state:item.state==='error'?'error':'running'})):[];}
 catch{return [];}
}
function rememberIntent(account:string,intent:PendingIntent){
 const all=readIntents(account).filter(item=>item.key!==intent.key);all.push(intent);
 try{localStorage.setItem(intentKey(account),JSON.stringify(all));}
 catch{throw Error('本机无法记录保存进度，请检查存储空间后重试');}
}
function forgetIntent(account:string,key:string){
 const all=readIntents(account).filter(item=>item.key!==key);
 try{if(all.length)localStorage.setItem(intentKey(account),JSON.stringify(all));else localStorage.removeItem(intentKey(account));}catch{}
}
export function pendingCloudJob(a:Attachment,c:MediaContext):Pick<PendingIntent,'targetName'|'state'>|undefined{
 const prefix=`${identity(a,c)}:`;
 const matches=readIntents(c.account).filter(item=>!item.forward&&item.key.startsWith(prefix)&&item.key===cloudJobKey(a,c,item.targetName));return matches[matches.length-1];
}
export function getCloudJob(a:Attachment,c:MediaContext){const prefix=`${identity(a,c)}:personal:`;return [...jobs].reverse().find(([key])=>key.startsWith(prefix))?.[1];}
function changed(job:CloudJob){window.dispatchEvent(new CustomEvent(CLOUD_JOB_CHANGED,{detail:job}));}
export function startCloudJob(a:Attachment,c:MediaContext,content?:UploadSource,knownFile?:CloudFile,targetName=a.name):CloudJob{
 const key=cloudJobKey(a,c,targetName),existing=jobs.get(key);
 if(existing?.state==='running')return existing;
 if(existing?.state==='complete'&&!content)return existing;
 rememberIntent(c.account,{key,forward:false,targetName,createdAt:Date.now(),state:'running'});
 const job:CloudJob={key,account:c.account,state:'running',stage:'准备保存…',promise:undefined!};
 jobs.set(key,job);
 const controller=new AbortController();
 controllers.set(key,controller);
 const check=()=>{if(controller.signal.aborted||jobs.get(key)!==job)throw new DOMException('保存已取消','AbortError');};
 job.promise=(async()=>{
  try{
   check();
   if(knownFile&&content){job.stage='正在核对已保存文件…';changed(job);await verifyCloudContent(knownFile,content,controller.signal,stage=>{job.stage=stage;changed(job);});}
   check();
   const file=knownFile||await saveCloudFile(a,c,controller.signal,stage=>{check();job.stage=stage;changed(job);},content);check();job.file=file;
   if(job.file.name!==targetName){job.file=await renameCloudFile(a,c,job.file,targetName,controller.signal);check();}
   job.state='complete';job.stage='已存到梦空间';changed(job);return job;
  }catch(e){job.state='error';job.error=e instanceof Error?e.message:'保存未完成，可重试';job.stage='';if(jobs.get(key)===job){try{rememberIntent(c.account,{key,forward:false,targetName,createdAt:Date.now(),state:'error'});}catch{}changed(job);}throw e;}
  finally{if(jobs.get(key)===job&&job.state==='complete')forgetIntent(c.account,key);if(controllers.get(key)===controller)controllers.delete(key);if(jobs.size>40)for(const [oldKey,old] of jobs)if(old.state!=='running'&&oldKey!==key){jobs.delete(oldKey);if(jobs.size<=32)break;}}
 })();
 changed(job);return job;
}
export function clearCloudJobs(account:string){try{localStorage.removeItem(intentKey(account));}catch{}for(const [key,job] of jobs)if(job.account===account){controllers.get(key)?.abort();jobs.delete(key);}}

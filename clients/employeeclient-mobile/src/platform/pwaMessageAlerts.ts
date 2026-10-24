import {waitForOperation} from './operationDeadline.mjs';
import type {Notification as Notice} from '@/api/types';
import {captureApiLease} from '@/api/client';
import {metaGet,metaSet} from '@/session/db';
import {readPushIdentity,isSilentWebPush} from './webPushState';
import {createRecoveryGate} from './recoveryGate.mjs';
const startedAt=Date.now();
type Delivery={account:string;notice:Notice;lease:ReturnType<typeof captureApiLease>;banner:boolean;controller?:AbortController};
const pending=new Map<string,Delivery>();
let flight:Promise<void>|null=null,dirty=false;
const recovery=createRecoveryGate({base:5000,wake:()=>{void flush();}});
const keyOf=(account:string,id:string)=>account+'\0'+id;
const current=(key:string,entry:Delivery)=>entry.lease.valid()&&entry.lease.account===entry.account&&pending.get(key)===entry&&!entry.controller?.signal.aborted;
const retired=(n:Notice)=>!!(n.read_at||n.acked_at||n.hidden_at);

/** A post is not a display receipt. The SW replies only after its durable display
 * queue succeeds (including already-displayed/read deduplication). */
async function showThroughWorker(message:unknown,signal:AbortSignal):Promise<void>{
 const registration=await waitForOperation(navigator.serviceWorker.getRegistration(),signal) as ServiceWorkerRegistration|undefined;
 const worker=navigator.serviceWorker.controller||registration?.active;
 if(!worker)throw Error('notification_worker_not_ready');
 await new Promise<void>((resolve,reject)=>{
  const channel=new MessageChannel();
  const aborted=()=>finish(Error('notification_attempt_cancelled'));
  const finish=(error?:Error)=>{signal.removeEventListener('abort',aborted);clearTimeout(timer);channel.port1.close();error?reject(error):resolve();};
  const timer=setTimeout(()=>finish(Error('notification_display_unconfirmed')),5000);
  signal.addEventListener('abort',aborted,{once:true});if(signal.aborted){aborted();return;}
  channel.port1.onmessage=event=>finish(event.data?.ok===true?undefined:Error('notification_display_failed'));
  try{worker.postMessage({type:'qn-present-chat',message},[channel.port2]);}catch(error){finish(error instanceof Error?error:Error('notification_display_failed'));}
 });
}
async function deliver(key:string,entry:Delivery):Promise<boolean>{
 const {account,notice:n}=entry;
 if(!entry.lease.valid()||pending.get(key)!==entry)return true;
 const controller=new AbortController();entry.controller=controller;const timer=setTimeout(()=>controller.abort(),15000);
 try{
 const log=await waitForOperation(metaGet<Record<string,number>>(account,'pwa-chat-alerts-v2'),controller.signal) as Record<string,number>||{};
 if(!current(key,entry))return true;
 if(retired(n)||(log[n.id]||0)>=n.update_version)return true;
 if(!entry.banner&&document.visibilityState==='visible'){
  window.dispatchEvent(new CustomEvent('qn-pwa-chat-alert',{detail:{account,notice:n}}));entry.banner=true;
 }
 const system=typeof Notification!=='undefined'&&Notification.permission==='granted'&&!!navigator.serviceWorker;
 if(system){
  const identity=await waitForOperation(readPushIdentity(),controller.signal) as Awaited<ReturnType<typeof readPushIdentity>>;if(!current(key,entry))return true;
  if(identity?.account!==account)throw Error('notification_identity_not_ready');
  await showThroughWorker({...n,recipient_username:account,installation_id:identity.installationId},controller.signal);
  if(!current(key,entry))return true;
 }else if(!entry.banner)return false; // No usable surface yet; retry on a lifecycle/permission event, not a permission polling loop.
 log[n.id]=Math.max(log[n.id]||0,n.update_version);
 if(current(key,entry))await waitForOperation(metaSet(account,'pwa-chat-alerts-v2',Object.fromEntries(Object.entries(log).slice(-1000)),()=>current(key,entry)),controller.signal);
 return true;
 }finally{clearTimeout(timer);}
}
function flush():Promise<void>{
 if(flight){dirty=true;return flight;}
 if(!recovery.ready())return Promise.resolve();
 const run=(async()=>{
  dirty=false;let failed=false;
  for(const [key,entry] of [...pending]){
   if(!entry.lease.valid()){pending.delete(key);continue;}
   try{if(await deliver(key,entry)&&current(key,entry))pending.delete(key);}catch{failed=true;}
  }
  if(failed&&pending.size)recovery.failed();else recovery.completed();
 })();
 const work=run.finally(()=>{if(flight===work)flight=null;if(dirty&&!recovery.waiting)void flush();});flight=work;return work;
}
export function presentPwaMessages(account:string,items:Notice[],catchup:boolean):Promise<void>{
 const lease=captureApiLease();if(!lease.valid()||lease.account!==account)return Promise.resolve();
 for(const n of items){
  const key=keyOf(account,n.id),old=pending.get(key);
  if(retired(n)){old?.controller?.abort();pending.delete(key);continue;}
  if(n.kind!=='chat_message'||isSilentWebPush({...n,recipient_username:account,installation_id:''})||catchup&&n.created_at<startedAt)continue;
  if(old&&old.notice.update_version>=n.update_version)continue;
  old?.controller?.abort();pending.set(key,{account,notice:n,lease,banner:false});
 }
 // Presentation is independent of authoritative inbox synchronization.
 void flush();return Promise.resolve();
}
export function retryPwaMessages(){return flush();}
export function retirePwaMessages(account:string,items:Notice[]){
 for(const n of items){const key=keyOf(account,n.id),entry=pending.get(key);if(entry&&entry.notice.update_version<=n.update_version){entry.controller?.abort();pending.delete(key);}}
 if(!pending.size)recovery.cancel();
}

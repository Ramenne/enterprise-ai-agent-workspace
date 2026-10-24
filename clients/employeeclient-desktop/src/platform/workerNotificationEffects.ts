import {scheduleRecoveryWake} from './workerRecoveryWake';
import {enqueuePushEffect,claimPushEffect,finishPushEffect,ownsPushEffect,hasPushEffect,nextPushEffectRetryAt,retireWebPush,isSilentWebPush,type PushMessage,type PushEffectTask} from './webPushState';
import {applyMessageBadge} from './webBadge';
import {waitForOperation} from './operationDeadline.mjs';
import type {Notification as BusinessNotice,MessageBadgeSnapshot} from '@/api/types';

type Surface={registration:ServiceWorkerRegistration;display:(message:PushMessage)=>Promise<boolean>;hide:(tag:string,version?:number)=>Promise<void>};
let flight:Promise<boolean>|null=null,dirty=false;
let active:{task:PushEffectTask;controller:AbortController}|null=null;
const displayAllowed=()=>typeof Notification!=='undefined'&&Notification.permission==='granted';
// Waiting for permission is durable but has no execution/retry deadline.
// State-only read/recall controls remain executable with notifications denied.
export function nextNotificationEffectRetryAt(){return nextPushEffectRetryAt(displayAllowed());}
// BackgroundSync is a wake request, not an interval. The durable deadline below
// still blocks repeated lifecycle events and browser retry bursts.
export async function scheduleNotificationEffects(registration:ServiceWorkerRegistration,notifyPages=false){
 try{await scheduleRecoveryWake(registration,'qn-notification-effects',await waitForOperation(nextNotificationEffectRetryAt(),AbortSignal.timeout(2000)),notifyPages);}catch{}
}
export function retryNotificationEffects(surface:Surface):Promise<boolean>{
 if(flight){dirty=true;return flight;}
 const run=(async()=>{const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),20000);let processed=0;
  try{do{dirty=false;for(;processed<32&&!ctl.signal.aborted;processed++){
   const task=await waitForOperation(claimPushEffect(crypto.randomUUID(),()=>!ctl.signal.aborted,displayAllowed()),ctl.signal) as Awaited<ReturnType<typeof claimPushEffect>>;if(!task)break;
   let success=false;const attempt={task,controller:new AbortController()};active=attempt;
   const signal=AbortSignal.any([ctl.signal,attempt.controller.signal]);
   try{
    if(!task.stateOnly&&!displayAllowed())continue;
    if(!await waitForOperation(ownsPushEffect(task),signal))continue;
    const response=await fetch('/business/v1/notifications/'+encodeURIComponent(task.id),{credentials:'include',cache:'no-store',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])});
    if(response.status===404){await retireWebPush([{id:task.id,recipient_username:task.account,installation_id:task.installationId,update_version:task.version}],surface.hide);success=true;continue;}
    if(!response.ok)throw Error('notification_effect_unavailable');
    const value=await waitForOperation(response.json(),signal) as {notification?:BusinessNotice;message_badge?:MessageBadgeSnapshot};signal.throwIfAborted();
    if(!await waitForOperation(ownsPushEffect(task),signal))continue;
    const n=value.notification;if(!n||n.id!==task.id||!Number.isSafeInteger(n.update_version)||n.update_version<task.version)throw Error('notification_effect_revision');
    const message={...n,recipient_username:task.account,installation_id:task.installationId} as PushMessage;
    if(value.message_badge)await applyMessageBadge({account:task.account,installationId:task.installationId},value.message_badge);
    if(n.read_at||n.acked_at||n.hidden_at||n.expires_at&&n.expires_at<=Date.now()||isSilentWebPush(message)){
     await retireWebPush([message],surface.hide);success=true;
    }else if(task.stateOnly){success=true;} // State updates never make a new alert.
    else{
     if(typeof Notification!=='undefined'&&Notification.permission!=='granted')throw Error('notification_permission_unavailable');
     if(!await waitForOperation(ownsPushEffect(task),signal))continue;
     success=await waitForOperation(surface.display(message),signal) as boolean;
    }
   }catch{/* The shared, bounded retry deadline is persisted below. */}
   finally{if(active===attempt)active=null;const finish=new AbortController(),deadline=setTimeout(()=>finish.abort(),2000);try{await waitForOperation(finishPushEffect(task,success,()=>!finish.signal.aborted,!task.stateOnly&&!displayAllowed()),finish.signal);}catch{}finally{clearTimeout(deadline);}}
  }}while(dirty&&!ctl.signal.aborted&&processed<32);
  }catch{}finally{clearTimeout(timer);}
  try{return await waitForOperation(nextNotificationEffectRetryAt(),AbortSignal.timeout(2000))===null;}catch{return false;}
 })();flight=run;void run.finally(()=>{if(flight===run)flight=null;});return run;
}
export async function receiveNotificationEffect(message:PushMessage,surface:Surface):Promise<boolean>{
 const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),5000);
 try{if(!await waitForOperation(enqueuePushEffect(message,()=>!ctl.signal.aborted),ctl.signal))return false;}catch{return false;}finally{clearTimeout(timer);}
 const old=active;if(old&&old.task.account===message.recipient_username&&old.task.installationId===message.installation_id&&old.task.id===message.id&&old.task.version<message.update_version)old.controller.abort();
 // Persist before requesting the wake or attempting network/display work.
 await scheduleNotificationEffects(surface.registration);
 const done=await retryNotificationEffects(surface);if(!done)await scheduleNotificationEffects(surface.registration,true);try{return !await waitForOperation(hasPushEffect(message),AbortSignal.timeout(2000));}catch{return false;}
}

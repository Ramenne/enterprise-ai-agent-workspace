import {readBadgeEffect,ensureBadgeEffect,claimBadgeEffect,finishBadgeEffect,commitMessageBadge,type PushIdentity,type BadgeEffectTask} from './webPushState';
import {waitForOperation} from './operationDeadline.mjs';
import {scheduleRecoveryWake} from './workerRecoveryWake';
import type {MessageBadgeSnapshot} from '@/api/types';
// The Worker alone applies OS effects. Persisted snapshots and their application
// receipts have different lifetimes; failure must not discard the latter task.
const supported=()=>typeof navigator.setAppBadge==='function'&&typeof navigator.clearAppBadge==='function';
let flight:Promise<boolean>|null=null,dirty=false;
export async function nextBadgeRetryAt():Promise<number|null>{
 if(!supported())return null;
 const task=await waitForOperation(readBadgeEffect(),AbortSignal.timeout(2000)) as BadgeEffectTask|null;
 return task?Math.max(task.retryAt,task.lease?.until||0):null;
}
export async function scheduleBadgeEffects(registration:ServiceWorkerRegistration,notifyPages=true){
 try{await scheduleRecoveryWake(registration,'qn-badge-effects',await nextBadgeRetryAt(),notifyPages);}catch{}
}
export function restoreMessageBadge():Promise<boolean>{
 if(flight){dirty=true;return flight;}
 const work=(async()=>{let result=false;
  try{
   await waitForOperation(ensureBadgeEffect(),AbortSignal.timeout(2000));
   if(!supported())return false; // Capability absence waits for a real browser wake.
   let processed=0;
   do{dirty=false;
    const claimSignal=AbortSignal.timeout(2000);
    const task=await waitForOperation(claimBadgeEffect(crypto.randomUUID(),()=>!claimSignal.aborted),claimSignal) as BadgeEffectTask|null;
    if(!task)return !await waitForOperation(readBadgeEffect(),AbortSignal.timeout(2000));
    const registration=(globalThis as unknown as {registration?:ServiceWorkerRegistration}).registration;
    if(registration)await scheduleBadgeEffects(registration); // Wake is durable before an uncancelable OS call.
    const signal=AbortSignal.timeout(5000);let success=false;
    try{
     const count=task.snapshot?.count||0;
     const writing=count?navigator.setAppBadge(count):navigator.clearAppBadge();
     // OS calls cannot be canceled. If an old call finishes after our deadline,
     // reconcile the latest target even if it already had a successful receipt.
     void writing.then(()=>{if(signal.aborted)void ensureBadgeEffect(true).then(()=>restoreMessageBadge()).catch(()=>{});}).catch(()=>{});
     await waitForOperation(writing,signal);success=true;
    }catch{/* Release into persisted failure backoff below, without HTTP. */}
    const finished=await waitForOperation(finishBadgeEffect(task,success),AbortSignal.timeout(2000));
    result=success&&finished;
    if(!finished)dirty=true; // A newer target/identity replaced the old owner.
    processed++;
   }while(dirty&&processed<4);
   return result;
  }catch{return false;}
  finally{
   const registration=(globalThis as unknown as {registration?:ServiceWorkerRegistration}).registration;
   if(registration)await scheduleBadgeEffects(registration);
  }
 })();flight=work;void work.finally(()=>{if(flight===work)flight=null;});return work;
}
export async function applyMessageBadge(identity:PushIdentity,snapshot:MessageBadgeSnapshot):Promise<boolean>{
 const signal=AbortSignal.timeout(5000);
 try{if(!await waitForOperation(commitMessageBadge(identity,snapshot,()=>!signal.aborted),signal))return false;return await restoreMessageBadge();}catch{return false;}
}

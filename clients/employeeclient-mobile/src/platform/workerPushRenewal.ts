import {scheduleRecoveryWake} from './workerRecoveryWake';
import {claimPushTask,failPushTask} from './pushTask';
import {CLIENT_RELEASE} from '@/app/release';
import {commitPushSubscription} from './pushSubscriptionCommit.mjs';
import {waitForOperation} from './operationDeadline.mjs';
import {readPushIdentity,readPendingPushRenewal,savePushRenewal,type PendingPushRenewal} from './webPushState';

// PushManager.subscribe cannot be canceled. If it finishes after our deadline,
// treat completion as a fresh event, not as authority to publish the old result.
// Adopt only the browser's still-current subscription and the same pending owner.
async function adoptLateSubscription(registration:ServiceWorkerRegistration,identity:NonNullable<Awaited<ReturnType<typeof readPushIdentity>>>,subscription:PushSubscription):Promise<void>{
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000),signal=controller.signal;
 try{
  const local=await waitForOperation(readPushIdentity(),signal) as Awaited<ReturnType<typeof readPushIdentity>>;
  if(!local||local.account!==identity.account||local.installationId!==identity.installationId||local.subscriptionFingerprint!==identity.subscriptionFingerprint)return;
  const pending=await waitForOperation(readPendingPushRenewal(),signal) as PendingPushRenewal|null;
  if(!pending||pending.subscription||pending.identity.account!==identity.account||pending.identity.installationId!==identity.installationId||pending.identity.subscriptionFingerprint!==identity.subscriptionFingerprint)return;
  const current=await waitForOperation(registration.pushManager.getSubscription(),signal) as PushSubscription|null;
  const active=current?.toJSON(),late=subscription.toJSON();
  if(!active||active.endpoint!==late.endpoint||active.keys?.auth!==late.keys?.auth||active.keys?.p256dh!==late.keys?.p256dh)return;
  if(await waitForOperation(savePushRenewal({...pending,subscription:late},undefined,()=>!signal.aborted,pending),signal))void renewWorkerPush(registration).then(()=>scheduleWorkerPushRenewal(registration)).catch(()=>{});
 }catch{/* Durable pending work remains for a future browser wake. */}finally{clearTimeout(timer);}
}

// No login secret is stored in worker storage. Retry deadlines survive worker
// termination; browser wakeups merge demand and cannot advance those deadlines.
const sameOwner=(a:PendingPushRenewal['identity'],b:PendingPushRenewal['identity'])=>a.account===b.account&&a.installationId===b.installationId;
async function renewOnce(registration:ServiceWorkerRegistration,changed?:{newSubscription?:PushSubscription|null;oldSubscription?:PushSubscription|null},attempt=0,parent?:AbortSignal):Promise<void>{
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000),signal=parent?AbortSignal.any([controller.signal,parent]):controller.signal;
 let pending:PendingPushRenewal|null=null;
 try{
  if(typeof Notification!=='undefined'&&Notification.permission!=='granted')return;
  const identity=await waitForOperation(readPushIdentity(),signal) as Awaited<ReturnType<typeof readPushIdentity>>;if(!identity?.account||!identity.installationId)return;
  pending=await waitForOperation(readPendingPushRenewal(),signal) as PendingPushRenewal|null;
  if(pending&&!sameOwner(pending.identity,identity))return;
  if(changed||pending&&pending.identity.subscriptionFingerprint!==identity.subscriptionFingerprint){
   const previous=pending;pending={...pending,identity,discoveryOnly:false,...(changed?{subscription:changed.newSubscription?.toJSON()}:{} )};
   if(!await waitForOperation(savePushRenewal(pending,undefined,()=>!signal.aborted,previous||'create'),signal))return;
  }
  if(!pending){
   // Persist a local-discovery intent before a browser API can hang. Healthy
   // discovery completes locally; only a missing/changed subscription uses HTTP.
   pending={identity,discoveryOnly:true};
   if(!await waitForOperation(savePushRenewal(pending,undefined,()=>!signal.aborted,'create'),signal))return;
  }
  if(!pending)return;
  // One attempt lease is shared with all pages and other worker instances.
  if(!parent){const claimed=await claimPushTask(identity.account,'worker-'+crypto.randomUUID(),12000,signal);if(!claimed.pending)return;pending=claimed.pending;}
  if((pending.retryAt||0)>Date.now())return;
  // A killed Worker cannot run finally: arrange the lease-expiry wake first.
  await scheduleRecoveryWake(registration,'qn-push-renewal',Math.max(pending.retryAt||0,pending.lease?.until||0));
  if(!pending.subscription){
   let subscription=await waitForOperation(registration.pushManager.getSubscription(),signal) as PushSubscription|null;
   if(subscription&&pending.discoveryOnly&&identity.subscriptionFingerprint){
    const json=subscription.toJSON(),canonical=JSON.stringify({endpoint:json.endpoint,keys:{p256dh:json.keys?.p256dh,auth:json.keys?.auth}});
    const digest=await waitForOperation(crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical)),signal) as ArrayBuffer;
    if(Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('')===identity.subscriptionFingerprint){
     await waitForOperation(savePushRenewal(pending,identity.subscriptionFingerprint,()=>!signal.aborted,pending),signal);return;
    }
   }
   if(!subscription){
    const response=await fetch('/business/v1/push-config',{credentials:'include',redirect:'error',signal});if(!response.ok)throw Object.assign(Error('push_config_unavailable'),{status:response.status,code:'push_config_unavailable'});
    const config=await response.json();signal.throwIfAborted();const encoded=config.web_push?.application_server_key;if(typeof encoded!=='string')throw Error('push_config_invalid');
    const key=Uint8Array.from(atob(encoded.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
    const creating=registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
    void creating.then(late=>{if(signal.aborted)void adoptLateSubscription(registration,identity,late);}).catch(()=>{});
    subscription=await waitForOperation(creating,signal) as PushSubscription;
   }
   const previous=pending;pending={...pending,subscription:subscription.toJSON()};if(!await waitForOperation(savePushRenewal(pending,undefined,()=>!signal.aborted,previous),signal))return;
  }
  const request=async(path:string,options:RequestInit={})=>{const response=await fetch(path,{credentials:'include',redirect:'error',...options,signal});const value=await response.json();signal.throwIfAborted();if(!response.ok)throw Object.assign(Error(value.error_code||'push_registration_failed'),{code:value.error_code||'push_registration_failed',status:response.status});return value;};
  let result;
  try{result=await commitPushSubscription({signal,expected:identity.subscriptionFingerprint??null,readCurrent:()=>registration.pushManager.getSubscription(),readRevision:async()=>{
   const result=await request('/business/v1/devices'),device=result.devices?.find((d:{installation_id:string})=>d.installation_id===identity.installationId);
   if(!device||device.status!=='active')throw Object.assign(Error('device_not_active'),{code:'device_not_active',status:404});return device.subscription_fingerprint??null;
  },write:async(subscription:PushSubscriptionJSON,expected:string|null)=>{
   const previous=pending!;pending={...previous,subscription};if(!await waitForOperation(savePushRenewal(pending,undefined,()=>!signal.aborted,previous),signal))throw new DOMException('订阅任务已变化','AbortError');
   const diagnostic={client_version:CLIENT_RELEASE.versionCode,permission:typeof Notification==='undefined'?'unknown':Notification.permission,phase:'registration',code:pending.lastError||'ready'};
   const post=(path:string,body:unknown)=>request(path,{method:'POST',headers:{'content-type':'application/json','idempotency-key':'push-renew-'+crypto.randomUUID()},body:JSON.stringify(body)});
   try{return await post('/business/v1/devices/'+encodeURIComponent(identity.installationId)+'/subscription',{expected_fingerprint:expected,subscription,diagnostic});}
   catch(error){
    if((error as {status?:number}).status!==404||!pending.sourceInstallationId)throw error;
    // A page may close before its first bind reached the server. Create only
    // that missing installation; an explicitly revoked installation stays revoked.
    const rows=await request('/business/v1/devices');if(rows.devices?.some((d:{installation_id:string})=>d.installation_id===identity.installationId))throw error;
    return post('/business/v1/devices',{installation_id:pending.sourceInstallationId,platform:'ios_web_push',expected_fingerprint:expected,subscription,diagnostic});
   }
  }});}catch(error){
   const rejection=error as {code?:string;rejectedSubscription?:PushSubscriptionJSON};if(rejection.code!=='push_subscription_expired')throw error;
   const current=await waitForOperation(registration.pushManager.getSubscription(),signal) as PushSubscription|null,local=await waitForOperation(readPushIdentity(),signal) as Awaited<ReturnType<typeof readPushIdentity>>;
   if(!local||!sameOwner(local,identity)||local.subscriptionFingerprint!==identity.subscriptionFingerprint)return;
   const active=current?.toJSON(),rejected=rejection.rejectedSubscription;
   if(active?.endpoint===rejected?.endpoint&&active?.keys?.auth===rejected?.keys?.auth&&active?.keys?.p256dh===rejected?.keys?.p256dh&&!await waitForOperation(current!.unsubscribe(),signal))throw Error('push_unsubscribe_failed');
   const previous=pending!;pending={...previous,subscription:undefined};if(!await waitForOperation(savePushRenewal(pending,undefined,()=>!signal.aborted,previous),signal))return;
   if(attempt<1)await renewOnce(registration,undefined,attempt+1,signal);return;
  }
  const fingerprint=result.device?.subscription_fingerprint;
  if(result.push_bound&&result.device?.installation_id===identity.installationId&&typeof fingerprint==='string'&&/^[a-f0-9]{64}$/.test(fingerprint))await waitForOperation(savePushRenewal(pending!,fingerprint,()=>!signal.aborted,pending!),signal);
 }catch(error){
  if(pending)await failPushTask(pending,error);

 }finally{clearTimeout(timer);}
}

let renewalFlight:Promise<void>|null=null,queuedChange:{newSubscription?:PushSubscription|null;oldSubscription?:PushSubscription|null}|undefined;
export function renewWorkerPush(registration:ServiceWorkerRegistration,changed?:{newSubscription?:PushSubscription|null;oldSubscription?:PushSubscription|null}):Promise<void>{
 if(changed)queuedChange=changed;if(renewalFlight)return renewalFlight;
 const work=(async()=>{do{const next=queuedChange;queuedChange=undefined;await renewOnce(registration,next);}while(queuedChange);})();
 renewalFlight=work;void work.finally(()=>{if(renewalFlight===work)renewalFlight=null;});return work;
}

export async function nextPushRenewalRetryAt():Promise<number|null>{
 if(typeof Notification!=='undefined'&&Notification.permission!=='granted')return null;
 const signal=AbortSignal.timeout(2000);
 const [pending,identity]=await waitForOperation(Promise.all([readPendingPushRenewal(),readPushIdentity()]),signal) as [PendingPushRenewal|null,Awaited<ReturnType<typeof readPushIdentity>>];
 if(!pending||!identity||!sameOwner(pending.identity,identity))return null;
 return Math.max(pending.retryAt||0,pending.lease?.until||0);
}
export async function scheduleWorkerPushRenewal(registration:ServiceWorkerRegistration,notifyPages=true):Promise<void>{
 try{await scheduleRecoveryWake(registration,'qn-push-renewal',await nextPushRenewalRetryAt(),notifyPages);}catch{}
}

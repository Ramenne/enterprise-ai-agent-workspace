import {waitForOperation} from './operationDeadline.mjs';
// Shared only with this installation's SW: identity + display-version metadata.
// Not a notification business ledger; V8 remains authoritative.
export interface PushIdentity { account: string; installationId: string; subscriptionFingerprint?: string }
export interface PushMessage { state_only?:boolean; created_at?:number; message_badge?:import('@/api/types').MessageBadgeSnapshot; id: string; recipient_username: string; installation_id: string; update_version: number; kind?: string; object_type?:string;object_id?:string;project_id?:string; title?: string; summary?: string; deep_link?: string; priority?: string; silent?: boolean; snapshot?: { silent?: boolean; attention?: string;conversation_peer?:string;work_item_id?:string;project_id?:string } }
export function isSilentWebPush(message: PushMessage): boolean { return !isRelevantNotice(message,message.recipient_username||'') || message.priority !== 'urgent' && (message.silent === true || message.snapshot?.silent === true); }
interface DisplayRecord { key: string; version: number; shownVersion: number; retiredVersion?:number }
let database: Promise<IDBDatabase> | undefined;
function open() {
  return database ||= new Promise<IDBDatabase>((resolve,reject)=>{
    const r=indexedDB.open('employeeclient-push-display',1);
    r.onupgradeneeded=()=>{r.result.createObjectStore('state');};
    r.onsuccess=()=>resolve(r.result);r.onerror=()=>{database=undefined;reject(r.error);};
  });
}
function same(i: PushIdentity | null, m: PushMessage) { return !!i && i.account===m.recipient_username && i.installationId===m.installation_id; }
export async function setPushIdentity(identity: PushIdentity | null, valid = () => true,expected?:PushIdentity): Promise<boolean> {
  const db=await open();
  if(!valid())return false;let saved=false,resetBadge=false;
  const tx=db.transaction('state','readwrite');
  const os=tx.objectStore('state'),request=os.get('identity');
  request.onsuccess=()=>{
    if(!valid())return;const old=request.result as PushIdentity|null;
    if(expected&&(!old||old.account!==expected.account||old.installationId!==expected.installationId||old.subscriptionFingerprint!==expected.subscriptionFingerprint))return;
    const sameDevice=!!identity&&old?.account===identity.account&&old?.installationId===identity.installationId;
    if(!sameDevice){os.delete('message-badge');stageBadgeEffect(os,identity,null,valid);resetBadge=true;}
    if(!sameDevice||identity?.subscriptionFingerprint&&identity.subscriptionFingerprint!==old?.subscriptionFingerprint)os.delete('renewal');
    os.put(sameDevice?{...old,...identity,subscriptionFingerprint:identity.subscriptionFingerprint??old?.subscriptionFingerprint}:identity,'identity');saved=true;
  };
  await new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});if(resetBadge&&typeof navigator!=='undefined')navigator.serviceWorker?.controller?.postMessage({type:'qn-message-badge'});return saved;
}
export async function matchesPushIdentity(account: string, installationId: string): Promise<boolean> {
  const db=await open(),tx=db.transaction('state','readonly');
  const request=tx.objectStore('state').get('identity');
  return new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(same(request.result,{recipient_username:account,installation_id:installationId} as PushMessage));request.onerror=()=>reject(request.error);});
}
async function state(message: PushMessage, shown = false,valid=()=>true,retire=false): Promise<DisplayRecord | null> {
  const db=await open();if(!valid())return null;const tx=db.transaction('state','readwrite'),os=tx.objectStore('state');
  const key=JSON.stringify([message.recipient_username,message.installation_id,message.id]);
  let result: DisplayRecord | null=null;
  const identity=os.get('identity');
  identity.onsuccess=()=>{
    if (!valid()||!same(identity.result,message)) return;
    const get=os.get(key);
    get.onsuccess=()=>{
      if(!valid())return;const old=get.result as DisplayRecord | undefined;
      if (old && old.version>message.update_version) return;
      // Display metadata only. Never retain a second copy of message content.
      result={key,version:Math.max(old?.version || 0,message.update_version),shownVersion:old?.shownVersion || 0,retiredVersion:old?.retiredVersion||0};
      if (shown) result.shownVersion=Math.max(result.shownVersion,message.update_version);
      if(retire)result.retiredVersion=Math.max(result.retiredVersion||0,message.update_version);
      os.put(result,key);
    };
  };
  await new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});
  return result;
}
// Serialise simultaneous push events; persist received and shown versions separately.
// If display fails, shownVersion is not advanced and a redelivery may retry.
let tail:Promise<unknown>=Promise.resolve();
function enqueue<T>(operation:(signal:AbortSignal)=>Promise<T>):Promise<T>{
 const work=tail.catch(()=>{}).then(async()=>{const controller=new AbortController(),timer=setTimeout(()=>controller.abort(new DOMException('通知展示超时','TimeoutError')),15000);try{return await waitForOperation(operation(controller.signal),controller.signal);}finally{clearTimeout(timer);}});
 tail=work;return work;
}
async function completeLateDisplay(message:PushMessage,tag:string,hide?:(tag:string,version?:number)=>Promise<void>){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);
 try{
  const db=await waitForOperation(open(),controller.signal) as IDBDatabase;
  const tx=db.transaction('state','readwrite'),os=tx.objectStore('state'),identity=os.get('identity');let close=false;
  identity.onsuccess=()=>{if(controller.signal.aborted)return;const key=JSON.stringify([message.recipient_username,message.installation_id,message.id]),r=os.get(key);r.onsuccess=()=>{if(controller.signal.aborted)return;const record=r.result as DisplayRecord|undefined;
   if(!same(identity.result,message)||!record||record.version!==message.update_version||(record.retiredVersion||0)>=message.update_version){close=true;return;}
   os.put({...record,shownVersion:Math.max(record.shownVersion,message.update_version)},key);
  };};
  await waitForOperation(new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);}),controller.signal);
  if(close&&hide)await waitForOperation(hide(tag,message.update_version),controller.signal);
 }catch{}finally{clearTimeout(timer);}
}
export function retireWebPush(messages:PushMessage[],hide:(tag:string,version?:number)=>Promise<void>):Promise<void>{
 return enqueue(async signal=>{const tags:string[]=[];for(const message of messages){signal.throwIfAborted();if(!message?.id||!Number.isSafeInteger(message.update_version)||message.update_version<1)continue;const record=await state(message,true,()=>!signal.aborted,true);signal.throwIfAborted();if(record)tags.push('qn-'+encodeURIComponent(record.key));}await waitForOperation(Promise.all(tags.map(tag=>hide(tag))),signal);});
}
export function receiveWebPush(message:PushMessage,display:(message:PushMessage,tag:string,alert:boolean,signal?:AbortSignal)=>Promise<void>,hide?:(tag:string,version?:number)=>Promise<void>):Promise<boolean>{
 return enqueue(async signal=>{
  if(!message||!message.id||!message.recipient_username||!message.installation_id||!Number.isSafeInteger(message.update_version)||message.update_version<1||isSilentWebPush(message))return false;
  const record=await state(message,false,()=>!signal.aborted);signal.throwIfAborted();
  if(!record)return false;if(record.shownVersion>=record.version)return true;
  const tag='qn-'+encodeURIComponent(record.key);
  if(!await matchesPushIdentity(message.recipient_username,message.installation_id))return false;signal.throwIfAborted();
  const now=Date.now(),alertKey=JSON.stringify(['alert',message.recipient_username,message.installation_id]);
  const db=await open();signal.throwIfAborted();const request=db.transaction('state','readonly').objectStore('state').get(alertKey);
  const previous=await new Promise<{normal?:number;urgent?:number}>((resolve,reject)=>{request.onsuccess=()=>resolve(request.result||{});request.onerror=()=>reject(request.error);});signal.throwIfAborted();
  const urgent=message.priority==='urgent',last=urgent?previous.urgent:Math.max(previous.normal||0,previous.urgent||0),alert=!last||now<last||now-last>=3000;
  const showing=display(message,tag,alert,signal);
  void showing.then(()=>{if(signal.aborted)void completeLateDisplay(message,tag,hide);}).catch(()=>{});
  await waitForOperation(showing,signal);signal.throwIfAborted();
  if(alert){const tx=db.transaction('state','readwrite');tx.objectStore('state').put({...previous,[urgent?'urgent':'normal']:now},alertKey);await new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}signal.throwIfAborted();
  if(!await state(message,true,()=>!signal.aborted)){if(hide)await waitForOperation(hide(tag,message.update_version),signal);return false;}
  signal.throwIfAborted();return true;
 });
}
import {isRelevantNotice} from '../domain/notificationAudience.mjs';

export async function readPushIdentity():Promise<PushIdentity|null>{
 const db=await open(),tx=db.transaction('state','readonly'),r=tx.objectStore('state').get('identity');
 return new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result||null);r.onerror=()=>reject(r.error);});
}

export async function installationPushIdentity(account:string,installationId:string):Promise<PushIdentity>{
 const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(account+'\0'+installationId));
 return {account,installationId:'qn-'+Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('')};
}

export interface PendingPushRenewal { identity: PushIdentity; sourceInstallationId?:string; discoveryOnly?:boolean; subscription?: PushSubscriptionJSON; retryAt?:number; failures?:number; lastError?:string; lease?:{owner:string;until:number} }
export async function readPendingPushRenewal():Promise<PendingPushRenewal|null>{
 const db=await open(),r=db.transaction('state','readonly').objectStore('state').get('renewal');
 return new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result||null);r.onerror=()=>reject(r.error);});
}
// Both writes are guarded by the identity and revision captured before network work.
export async function savePushRenewal(pending:PendingPushRenewal,fingerprint?:string,valid=()=>true,guard:boolean|'create'|PendingPushRenewal=false):Promise<boolean>{
 const db=await open();if(!valid())return false;const tx=db.transaction('state','readwrite'),os=tx.objectStore('state'),r=os.get('identity');let saved=false;
 r.onsuccess=()=>{const current=r.result as PushIdentity|null;
  if(!valid()||!current||current.account!==pending.identity.account||current.installationId!==pending.identity.installationId||current.subscriptionFingerprint!==pending.identity.subscriptionFingerprint)return;
  const write=()=>{if(!valid())return;if(fingerprint){os.put({...current,subscriptionFingerprint:fingerprint},'identity');os.delete('renewal');}else os.put(pending,'renewal');saved=true;};
  if(guard){const q=os.get('renewal');q.onsuccess=()=>{const existing=q.result as PendingPushRenewal|undefined;
   if(guard==='create'){if(existing)return;}
   else if(guard===true){if(!existing||existing.subscription||existing.identity.account!==pending.identity.account||existing.identity.installationId!==pending.identity.installationId||existing.identity.subscriptionFingerprint!==pending.identity.subscriptionFingerprint)return;}
   else if(!existing||JSON.stringify(existing)!==JSON.stringify(guard))return;
   write();};}
  else write();
 };
 await new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});return saved;
}

// Atomic across tabs and worker instances. A live lease or persisted failure
// deadline cannot be shortened by another entry point's wake/force request.
export async function claimPushRenewal(account:string,owner:string,leaseMs:number,valid=()=>true,sourceInstallationId?:string):Promise<{pending:PendingPushRenewal|null;waitUntil:number}>{
 const db=await open();if(!valid())return {pending:null,waitUntil:0};
 const tx=db.transaction('state','readwrite'),os=tx.objectStore('state'),i=os.get('identity');let result:{pending:PendingPushRenewal|null;waitUntil:number}={pending:null,waitUntil:0};
 i.onsuccess=()=>{const identity=i.result as PushIdentity|null;if(!valid()||identity?.account!==account)return;
  const r=os.get('renewal');r.onsuccess=()=>{if(!valid())return;const old=r.result as PendingPushRenewal|undefined;
   if(old&&(old.identity.account!==identity.account||old.identity.installationId!==identity.installationId||old.identity.subscriptionFingerprint!==identity.subscriptionFingerprint))return;
   const until=Math.max(old?.retryAt||0,old?.lease?.until||0);if(until>Date.now()){result={pending:null,waitUntil:until};return;}
   const pending:PendingPushRenewal={...old,identity,...(sourceInstallationId&&/^[A-Za-z0-9_.:-]{2,128}$/.test(sourceInstallationId)?{sourceInstallationId}:{}),lease:{owner,until:Date.now()+leaseMs}};os.put(pending,'renewal');result={pending,waitUntil:0};
  };
 };
 await new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});return result;
}

export async function readMessageBadge():Promise<{identity:PushIdentity;snapshot:import('@/api/types').MessageBadgeSnapshot}|null>{
 const db=await open(),r=db.transaction('state','readonly').objectStore('state').get('message-badge');return await new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result||null);r.onerror=()=>reject(r.error);});
}
export async function commitMessageBadge(identity:PushIdentity,snapshot:import('@/api/types').MessageBadgeSnapshot,valid=()=>true):Promise<boolean>{
 if(!validMessageBadge(snapshot))return false;const db=await open();if(!valid())return false;let accepted=false;
 const tx=db.transaction('state','readwrite'),os=tx.objectStore('state'),i=os.get('identity');i.onsuccess=()=>{if(!valid()||!same(i.result,{recipient_username:identity.account,installation_id:identity.installationId} as PushMessage))return;
  const r=os.get('message-badge');r.onsuccess=()=>{if(!valid())return;const old=r.result;if(old&&old.identity.account===identity.account&&old.identity.installationId===identity.installationId&&!newerMessageBadge(snapshot,old.snapshot))return;os.put({identity:{account:identity.account,installationId:identity.installationId},snapshot},'message-badge');stageBadgeEffect(os,identity,snapshot,valid);accepted=true;};
 };await new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});return accepted;
}
import {validMessageBadge,newerMessageBadge} from '../domain/messageBadge.mjs';


// Recoverable delivery effects contain references only. Messages and read state
// are fetched from the same business authority before any background display.
export interface PushEffectTask {account:string;installationId:string;id:string;version:number;stateOnly:boolean;failures:number;retryAt:number;lease?:{owner:string;until:number}}
const effectKey=(v:Pick<PushEffectTask,'account'|'installationId'|'id'>)=>'effect:'+JSON.stringify([v.account,v.installationId,v.id]);
export async function enqueuePushEffect(message:PushMessage,valid=()=>true):Promise<boolean>{
 if(!message?.id||message.id.length>200||!Number.isSafeInteger(message.update_version)||message.update_version<1)return false;
 const db=await open();if(!valid())return false;const tx=db.transaction('state','readwrite'),os=tx.objectStore('state');let accepted=false;
 const i=os.get('identity');i.onsuccess=()=>{if(!valid()||!same(i.result,message))return;const key=effectKey({account:message.recipient_username,installationId:message.installation_id,id:message.id}),r=os.get(key);
  r.onsuccess=()=>{const old=r.result as PushEffectTask|undefined;if(!valid()||old&&old.version>message.update_version)return;
   const newer=!!old&&message.update_version>old.version;
   os.put({...old,account:message.recipient_username,installationId:message.installation_id,id:message.id,version:message.update_version,stateOnly:message.state_only===true||old?.version===message.update_version&&old.stateOnly===true,failures:old?.failures||0,retryAt:old?.retryAt||0,...(newer?{lease:undefined}:{})},key);
   // Publish the version barrier in the same transaction as task replacement.
   // An older authority result or delayed OS display cannot outlive this fence.
   const displayKey=JSON.stringify([message.recipient_username,message.installation_id,message.id]),display=os.get(displayKey);
   display.onsuccess=()=>{if(!valid())return;const record=display.result as DisplayRecord|undefined;if(!record||record.version<message.update_version)os.put({...record,key:displayKey,version:message.update_version,shownVersion:record?.shownVersion||0,retiredVersion:record?.retiredVersion||0},displayKey);};
   accepted=true;};
 };await new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});return accepted;
}
export async function claimPushEffect(owner:string,valid=()=>true,allowDisplay=true):Promise<PushEffectTask|null>{
 const db=await open();if(!valid())return null;const tx=db.transaction('state','readwrite'),os=tx.objectStore('state'),i=os.get('identity');let task:PushEffectTask|null=null;
 i.onsuccess=()=>{const r=os.getAll(IDBKeyRange.bound('effect:','effect:\uffff'));r.onsuccess=()=>{for(const v of r.result as PushEffectTask[]){
  if(!valid())return;
  if(i.result?.account!==v.account||i.result?.installationId!==v.installationId){os.delete(effectKey(v));continue;}
  if(!allowDisplay&&!v.stateOnly)continue;
  if(task||Math.max(v.retryAt,v.lease?.until||0)>Date.now())continue;
  task={...v,lease:{owner,until:Date.now()+30000}};os.put(task,effectKey(v));
 }};};await new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});return task;
}
export async function finishPushEffect(task:PushEffectTask,success:boolean,valid=()=>true,waitingForPermission=false):Promise<void>{
 const db=await open(),tx=db.transaction('state','readwrite'),os=tx.objectStore('state'),r=os.get(effectKey(task));
 r.onsuccess=()=>{const old=r.result as PushEffectTask|undefined;if(!valid()||!old||old.version!==task.version||old.lease?.owner!==task.lease?.owner)return;
  if(success)os.delete(effectKey(task));
  else if(waitingForPermission)os.put({...old,lease:undefined},effectKey(task));
  else{const failures=Math.min(9,old.failures+1);os.put({...old,failures,lease:undefined,retryAt:Date.now()+Math.min(300000,5000*2**(failures-1))},effectKey(task));}
 };await new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});
}
export async function ownsPushEffect(task:PushEffectTask):Promise<boolean>{
 const db=await open(),tx=db.transaction('state','readonly'),os=tx.objectStore('state'),i=os.get('identity');let owned=false;
 i.onsuccess=()=>{const r=os.get(effectKey(task));r.onsuccess=()=>{const current=r.result as PushEffectTask|undefined;owned=i.result?.account===task.account&&i.result?.installationId===task.installationId&&current?.version===task.version&&current?.lease?.owner===task.lease?.owner&&(current?.lease?.until||0)>Date.now();};};
 await new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});return owned;
}
export async function hasPushEffect(message:PushMessage):Promise<boolean>{
 const db=await open(),r=db.transaction('state','readonly').objectStore('state').get(effectKey({account:message.recipient_username,installationId:message.installation_id,id:message.id}));return new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(!!r.result);r.onerror=()=>reject(r.error);});
}
export async function hasPushEffects():Promise<boolean>{
 const db=await open(),tx=db.transaction('state','readonly'),r=tx.objectStore('state').count(IDBKeyRange.bound('effect:','effect:\uffff'));return new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result>0);r.onerror=()=>reject(r.error);});
}
export async function nextPushEffectRetryAt(allowDisplay=true):Promise<number|null>{
 const db=await open(),tx=db.transaction('state','readonly'),os=tx.objectStore('state'),i=os.get('identity');let next:number|null=null;
 i.onsuccess=()=>{const r=os.getAll(IDBKeyRange.bound('effect:','effect:\uffff'));r.onsuccess=()=>{for(const v of r.result as PushEffectTask[]){
  if(v.account!==i.result?.account||v.installationId!==i.result?.installationId)continue;
  if(!allowDisplay&&!v.stateOnly)continue;
  const at=Math.max(v.retryAt,v.lease?.until||0);if(next===null||at<next)next=at;
 }};};
 await new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});return next;
}


// The badge is a platform effect of the authoritative snapshot, not a second
// unread ledger. Persist intent in the same transaction as accepting that snapshot.
export interface BadgeEffectTask {identity:PushIdentity|null;snapshot:import('@/api/types').MessageBadgeSnapshot|null;revision:string;failures:number;retryAt:number;lease?:{owner:string;until:number}}
const badgeOwner=(a:PushIdentity|null|undefined,b:PushIdentity|null|undefined)=>a?.account===b?.account&&a?.installationId===b?.installationId;
function badgeTarget(a:Pick<BadgeEffectTask,'identity'|'snapshot'>|undefined,b:Pick<BadgeEffectTask,'identity'|'snapshot'>){return !!a&&badgeOwner(a.identity,b.identity)&&a.snapshot?.count===b.snapshot?.count&&a.snapshot?.version===b.snapshot?.version&&a.snapshot?.computed_at===b.snapshot?.computed_at;}
function stageBadgeEffect(os:IDBObjectStore,identity:PushIdentity|null,snapshot:BadgeEffectTask['snapshot'],valid=()=>true,force=false){
 const target={identity:identity?{account:identity.account,installationId:identity.installationId}:null,snapshot};
 const r=os.get('badge-effect');r.onsuccess=()=>{
  if(!valid())return;const old=r.result as BadgeEffectTask|undefined;
  // A currently executing latest write will already reconcile a late old OS result.
  if(badgeTarget(old,target))return;
  const put=()=>{if(valid())os.put({...target,revision:crypto.randomUUID(),failures:badgeOwner(old?.identity,identity)?old?.failures||0:0,retryAt:badgeOwner(old?.identity,identity)?old?.retryAt||0:0},'badge-effect');};
  if(old||force){put();return;}
  const receipt=os.get('badge-receipt');receipt.onsuccess=()=>{if(!badgeTarget(receipt.result,target))put();};
 };
}
export async function ensureBadgeEffect(force=false,valid=()=>true):Promise<void>{
 const db=await open(),tx=db.transaction('state','readwrite'),os=tx.objectStore('state'),i=os.get('identity');
 i.onsuccess=()=>{const identity=i.result as PushIdentity|null,r=os.get('message-badge');r.onsuccess=()=>{const record=r.result;stageBadgeEffect(os,identity,record&&badgeOwner(record.identity,identity)?record.snapshot:null,valid,force);};};
 await new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});
}
export async function readBadgeEffect():Promise<BadgeEffectTask|null>{
 const db=await open(),r=db.transaction('state','readonly').objectStore('state').get('badge-effect');return new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result||null);r.onerror=()=>reject(r.error);});
}
export async function claimBadgeEffect(owner:string,valid=()=>true):Promise<BadgeEffectTask|null>{
 const db=await open(),tx=db.transaction('state','readwrite'),os=tx.objectStore('state'),i=os.get('identity');let task:BadgeEffectTask|null=null;
 i.onsuccess=()=>{const r=os.get('badge-effect');r.onsuccess=()=>{const old=r.result as BadgeEffectTask|undefined;if(!valid()||!old||!badgeOwner(i.result,old.identity)||Math.max(old.retryAt,old.lease?.until||0)>Date.now())return;task={...old,lease:{owner,until:Date.now()+15000}};os.put(task,'badge-effect');};};
 await new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});return task;
}
export async function finishBadgeEffect(task:BadgeEffectTask,success:boolean,valid=()=>true,unsupported=false):Promise<boolean>{
 const db=await open(),tx=db.transaction('state','readwrite'),os=tx.objectStore('state'),i=os.get('identity');let finished=false;
 i.onsuccess=()=>{const r=os.get('badge-effect');r.onsuccess=()=>{const old=r.result as BadgeEffectTask|undefined;
  if(!valid()||!old||!badgeOwner(i.result,task.identity)||old.revision!==task.revision||old.lease?.owner!==task.lease?.owner||(old.lease?.until||0)<=Date.now())return;
  finished=true;if(success){os.put({identity:task.identity,snapshot:task.snapshot},'badge-receipt');os.delete('badge-effect');}
  else{const failures=unsupported?old.failures:Math.min(9,old.failures+1);os.put({...old,lease:undefined,failures,retryAt:unsupported?0:Date.now()+Math.min(300000,5000*2**(failures-1))},'badge-effect');}
 };};await new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});return finished;
}

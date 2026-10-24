import {isDesktopNative} from '@/platform/desktop';
import {claimPushTask,failPushTask} from '@/platform/pushTask';
import type {PendingPushRenewal} from '@/platform/webPushState';
import {savePushRenewal} from '@/platform/webPushState';
import {commitPushSubscription} from '@/platform/pushSubscriptionCommit.mjs';
import {waitForOperation} from '@/platform/operationDeadline.mjs';
import {createRecoveryGate} from '@/platform/recoveryGate.mjs';
import {noteVerifiedTransportIdentity} from '@/platform/liveTransport';
import {readWorkspaceResume,rememberWorkspace,forgetWorkspace} from './workspaceResume.mjs';
import {clearChatTransfers} from '@/files/chatTransfers';
import {userError} from '@/domain/userError.mjs';
import {requestMessageAccess} from '@/platform/messageAccess';
import {isAndroidNative} from '@/session/installation';
import {deviceLoginStorage} from './deviceLogin';
import {rememberEmail} from './login-preference.mjs';
import {defineStore} from 'pinia';
import {ref,computed} from 'vue';
import {NativeClient,NativeError} from '@/native/client.mjs';
import {serviceOrigin} from '@/api/runtime';
import {configureApi,isOnline,apiRequest,ApiError} from '@/api/client';
import {notifyChatWake} from '@/platform/chatEvents';
import {startLiveLink,stopLiveLink,pokeLiveLink,restartVerifiedTransport} from '@/platform/liveLink';
import {useDataStore} from '@/store/data';
import {useChatStore} from '@/store/chat';
import {setPushIdentity,installationPushIdentity,readPushIdentity} from '@/platform/webPushState';
import {metaGet,metaSet} from '@/session/db';
import {getPushSubscription,lastPushAvailability,scheduleWorkerPushRetry,readCurrentPushSubscription,pushDiagnostic,ensureNotificationPermission} from '@/platform/push';
import {getInstallationId,devicePlatform,hasWebPushSupport} from '@/session/installation';
import type {IdentityUser} from '@/api/types';
import type {LiveLinkSnapshot} from '@/platform/liveLink';
export type ConnectionStatus='anonymous'|'connecting'|'online'|'offline'|'expired'|'unbound'|'recovering';
export const useSessionStore=defineStore('session',()=>{
 const data=useDataStore(),chat=useChatStore();
 const status=ref<ConnectionStatus>('anonymous'),user=ref<IdentityUser|null>(null),ready=ref(false),lastError=ref('');
 const canPublishAnnouncement=ref(false),isMainControl=ref(false),counts=ref({my_company_tasks:0,my_personal_tasks:0,my_open_issues:0});
 const mode=ref<string>('native'),pushBound=ref(false),pushReason=ref('设备通知尚未验证'),installationId=ref(getInstallationId());
 const link=ref<LiveLinkSnapshot>({state:'stopped',foreground:true,networkUp:isOnline(),lastTickAt:null,lastDetail:'聊天与通知服务尚未接通',failures:0,rebuiltCount:0});
 const isAuthenticated=computed(()=>!!user.value&&(status.value==='online'||status.value==='offline'||status.value==='recovering'));
 const businessReady=ref(false),businessWritable=ref(false);
 const displayName=computed(()=>user.value?.nickname||user.value?.username||'');
 let generation=0;
 let restoreFlight:Promise<boolean>|null=null;
 let loginFlight:Promise<boolean>|null=null;
 let authorityFlight:Promise<void>|null=null;
 let resumeTransport=false,transportAuthFailures=0,transportAuthWindow=0;
 let authorityCheckedAt=0,memberVerifiedAt=0,authorityWanted=false,businessRecoveryWanted=false;
 let confirmedMember:Awaited<ReturnType<NativeClient['session']>>|null=null;
 let businessFlight:{ticket:number;work:Promise<boolean>}|null=null;
 const authorityRecovery=createRecoveryGate({base:5000,wake:()=>{if(!user.value)return;if(authorityWanted)onUnauthorized(resumeTransport);else if(businessRecoveryWanted)void connectBusiness(generation,user.value.username);}});
 let restoreRateLimited=false;
 function cancelAuthorityRetry(){authorityRecovery.cancel();resumeTransport=false;authorityWanted=false;businessRecoveryWanted=false;authorityCheckedAt=0;confirmedMember=null;}
 function retryTransportAuthority(ticket:number,delay:number){
  if(ticket!==generation)return;authorityWanted=true;authorityRecovery.defer(delay);
 }
 let pushFlight:{ticket:number;work:Promise<boolean>}|null=null,pushRecheckTicket:number|null=null;
 let pushCheckedAt=0,pushRetryTicket:number|null=null;
 function cancelPushRetry(){pushRecheckTicket=null;pushRecovery.cancel();pushRetryTicket=null;}
 function expireConfirmed(){cancelPushRetry();forgetWorkspace();cancelAuthorityRetry();if(user.value?.username)clearChatTransfers(user.value.username);void setPushIdentity(null).catch(()=>{});businessReady.value=false;businessWritable.value=false;pushBound.value=false;stopLiveLink('本人会话已过期');generation++;client.reset();status.value='expired';user.value=null;data.setAccount('');canPublishAnnouncement.value=false;isMainControl.value=false;void chat.setAccount('');}
 const client=new NativeClient({base:serviceOrigin(),onUnauthorized,loginStorage:deviceLoginStorage,requirePersistent:true});
 // Credential confirmation and business readiness are separate transitions.
 // One demand queue owns identity checks; ordinary business retries never reset it.
 function resumeVerifiedTransport(ticket:number){
  if(ticket!==generation||!resumeTransport||!businessReady.value)return;
  const now=Date.now();if(now-transportAuthWindow>60000){transportAuthWindow=now;transportAuthFailures=0;}
  if(transportAuthFailures<3){transportAuthFailures++;resumeTransport=false;restartVerifiedTransport();}
  else retryTransportAuthority(ticket,Math.max(1000,60001-(now-transportAuthWindow)));
 }
 function onUnauthorized(reconnectTransport=false){
  resumeTransport ||= reconnectTransport;
  if(!user.value)return;
  const ticket=generation,account=user.value.username,writable=businessWritable.value;
  if(authorityFlight){authorityWanted=true;return;}
  if(resumeTransport&&businessReady.value&&authorityCheckedAt&&Date.now()-authorityCheckedAt<60000){resumeVerifiedTransport(ticket);return;}
  authorityWanted=true;if(!authorityRecovery.ready())return;authorityWanted=false;
  const work=(async()=>{
   try{
    const cached=confirmedMember?.identity.actor_id===account&&authorityCheckedAt&&Date.now()-authorityCheckedAt<60000;
    const verified=cached?confirmedMember!:await client.session();if(ticket!==generation)return;
    if(verified.identity.actor_id!==account){expireConfirmed();return;}
    if(!cached){confirmedMember=verified;authorityCheckedAt=memberVerifiedAt=Date.now();noteVerifiedTransportIdentity(account);}
    authorityRecovery.completed(Math.max(0,60000-(Date.now()-authorityCheckedAt)));lastError.value='';
    if(!businessReady.value){
     status.value='recovering';
     if(!await connectBusiness(ticket,account)&&ticket===generation&&user.value&&String(status.value)!=='unbound'){
      authorityWanted=true;authorityRecovery.failed();
     }
    }else{businessWritable.value=writable;status.value=isOnline()?'online':'offline';resumeVerifiedTransport(ticket);}
   }catch(e){if(ticket!==generation)return;
    if(e instanceof NativeError&&e.status===401&&e.code!=='session_changed'){expireConfirmed();return;}
    if(e instanceof NativeError&&e.status===403){expireConfirmed();status.value='unbound';lastError.value=explain(e);return;}
    status.value='recovering';lastError.value=explain(e);authorityWanted=true;authorityRecovery.failed();
   }
  })();authorityFlight=work;
  void work.finally(()=>{if(authorityFlight===work)authorityFlight=null;if(ticket===generation&&authorityWanted&&!authorityRecovery.waiting)authorityRecovery.ready();});
 }

 function explain(e:unknown){return userError(e,'连接暂时不可用，请稍后重试');}
 async function identity(ticket:number,verified?:Awaited<ReturnType<NativeClient['session']>>){
  cancelAuthorityRetry();lastError.value='';
  const m=verified??await client.session();if(ticket!==generation)return false;
  const actor=m.identity.actor_id;memberVerifiedAt=Date.now();noteVerifiedTransportIdentity(actor);
  if(m.user?.email)rememberEmail(m.user.email);
  if(user.value&&user.value.username!==actor){clearChatTransfers(user.value.username);stopLiveLink('切换本人账号');cancelPushRetry();pushBound.value=false;pushCheckedAt=0;generation++;ticket=generation;}
  await setPushIdentity(await installationPushIdentity(actor,installationId.value),()=>ticket===generation);if(ticket!==generation)return false;
  user.value={username:actor,nickname:m.user?.name||m.identity.member_label||actor,dept:'',role:m.identity.member_role||''};
  // No old token, qn1 exchange, personal-space API or implicit manager promotion.
  canPublishAnnouncement.value=false;isMainControl.value=false;data.setMainControl(false);data.setAccount(actor);
  configureApi({isVerified:()=>businessReady.value,canWrite:()=>businessReady.value,fastMedia:false,getToken:()=>null,getAccount:()=>user.value?.username||'',getEpoch:()=>generation,onUnauthorized});
  return connectBusiness(ticket,actor);
 }
 function connectBusiness(ticket:number,actor:string):Promise<boolean>{
  if(businessFlight?.ticket===ticket)return businessFlight.work;
  const work=runBusiness(ticket,actor).finally(()=>{if(businessFlight?.work===work)businessFlight=null;});
  businessFlight={ticket,work};return work;
 }
 async function runBusiness(ticket:number,actor:string){
  stopLiveLink('恢复本人工作区', false);businessReady.value=false;businessWritable.value=false;
  status.value='recovering';link.value.networkUp=isOnline();ready.value=true;
  try{
   const b=await apiRequest<{actor_id:string;can_read:boolean;can_write:boolean;can_publish_announcement:boolean;is_manager?:boolean;capabilities:{events:boolean;devices:boolean;push:boolean;fast_media?:boolean}}>('GET','/business/v1/bootstrap');
   if(ticket!==generation)return false;
   configureApi({fastMedia:b.capabilities.fast_media===true});
   if(b.actor_id!==actor||!b.can_read)throw new ApiError('forbidden_scope','员工客户端项目读取资格未确认',403);
   businessRecoveryWanted=false;authorityRecovery.completed(authorityCheckedAt?Math.max(0,60000-(Date.now()-authorityCheckedAt)):0);
   businessReady.value=true;status.value=isOnline()?'online':'offline';rememberWorkspace(user.value);businessWritable.value=b.can_write;canPublishAnnouncement.value=b.can_publish_announcement;isMainControl.value=b.is_manager===true;data.setMainControl(b.is_manager===true);
   await Promise.all([data.hydrateFromCache(actor),chat.setAccount(actor,chat.account===actor?chat.peer:'')]);if(ticket!==generation)return false;
   // The view can now render the authorized local snapshot. Network catch-up,
   // legacy import and device registration never hold the startup route closed.
   if(b.capabilities.events)startLiveLink({account:actor,shouldRun:()=>ticket===generation&&businessReady.value,
    onBadge:badge=>{if(ticket===generation)data.acceptMessageBadge(actor,badge);},
    onTick:async(mode,hint)=>{
     if(hint?.kinds?.includes('push_subscription_expired')){
      if(ticket===generation&&!isAndroidNative()){pushBound.value=false;void syncPushBinding(false,true);}
      if(hint.kinds.length===1)return;
     }
     // Notification recovery owns its cursor and never waits for another domain.
     const chatBefore=data.chatRevision,annBefore=data.announcementRevision;
     const chatHint=hint?.kinds?.includes('chat_message'),peerMatches=!hint?.conversationPeers?.length||hint.conversationPeers.includes(chat.peer||'');
     const chatStarted=mode==='catchup'||!!chatHint&&peerMatches;
     // Explicit domain hints start their authoritative reads independently.
     // A slow inbox must not delay showing a newly received chat message.
     if(chatStarted)void chat.refresh({changed:true}).catch(()=>{});
     if(mode==='catchup'||hint?.kinds?.some(k=>k==='member_presence'||k==='member_avatar'))void chat.refreshMembers(true,mode==='live');
     if(mode==='catchup')void data.syncLists(actor).catch(()=>{});
     await data.syncNotifications(actor,false,mode,hint);
     if(ticket!==generation)return;
     if(!chatStarted&&data.chatRevision!==chatBefore&&peerMatches)void chat.refresh({changed:true}).catch(()=>{});
     if(chatHint&&data.chatRevision===chatBefore)notifyChatWake(actor,'live',[],hint);
     if(data.announcementRevision!==annBefore||hint?.kinds?.includes('announcement_read'))void data.syncLists(actor,true).catch(()=>{});
    },
    onAuthLost:e=>{if(ticket!==generation)return;if(e instanceof ApiError&&e.status===401){onUnauthorized(true);return;}cancelAuthorityRetry();cancelPushRetry();pushBound.value=false;stopLiveLink('员工客户端项目资格已变更');businessReady.value=false;businessWritable.value=false;data.setAccount('');void chat.setAccount('');status.value='unbound';canPublishAnnouncement.value=false;isMainControl.value=false;data.setMainControl(false);lastError.value='员工客户端项目资格已变更，请重新连接';},
    onNetworkChange:up=>{if(ticket===generation){status.value=up?'online':'offline';if(up)void syncPushBinding(false);}},onStateChange:s=>{if(ticket===generation)link.value=s;}});
   if(isAndroidNative())void requestMessageAccess(()=>ticket===generation&&businessReady.value);
   if(b.capabilities.devices)void syncPushBinding(false);else pushReason.value='设备登记服务尚未接通';
   if(!b.capabilities.events)void Promise.allSettled([data.syncNotifications(actor,false,'catchup'),data.syncLists(actor),chat.refresh()]);
   if(b.can_write)void (async()=>{
    const marker='legacy_import_v1_complete';
    if(await metaGet(actor,marker)||ticket!==generation)return;
    try{
     await apiRequest('POST','/business/v1/migration',{body:{},idempotencyKey:'employeeclient-history-import-v1'});
     if(ticket===generation){await metaSet(actor,marker,true);await Promise.allSettled([data.syncNotifications(actor,false,'catchup'),data.syncLists(actor),chat.refresh()]);}
    }catch(e){if(ticket===generation)lastError.value='历史资料接续尚未完成：'+explain(e);}
   })();
  }catch(e){if(ticket!==generation)return false;if(e instanceof ApiError&&e.status===401){status.value='recovering';businessReady.value=false;businessRecoveryWanted=true;onUnauthorized();return false;}
   businessReady.value=false;businessWritable.value=false;lastError.value=explain(e);
   const denied=e instanceof ApiError&&e.status===403;
   if(denied){cancelAuthorityRetry();data.setAccount('');await chat.setAccount('');}
   else{businessRecoveryWanted=true;authorityRecovery.failed();}
   status.value=denied?'unbound':'recovering';
   return false;
  }
  return true;
 }
 async function restoreCachedWorkspace(){
  if(user.value)return true;const snapshot=readWorkspaceResume();if(!snapshot)return false;
  try{await deviceLoginStorage.restore();}catch{return false;}
  if(user.value)return true;
  const actor=snapshot.account;
  user.value={username:actor,nickname:snapshot.name,dept:'',role:''};status.value='recovering';
  businessReady.value=false;businessWritable.value=false;link.value.networkUp=false;
  configureApi({getToken:()=>null,getAccount:()=>user.value?.username||'',getEpoch:()=>generation,onUnauthorized,isVerified:()=>businessReady.value,canWrite:()=>businessReady.value});
  data.setAccount(actor);await Promise.all([data.hydrateFromCache(actor),chat.setAccount(actor)]);
  ready.value=true;return user.value?.username===actor;
 }
 async function sendCode(email:string){lastError.value='';try{await client.sendCode(email);rememberEmail(email);return true;}catch(e){lastError.value=explain(e);return false;}}
 async function loginOnce(email:string,otp:string){cancelAuthorityRetry();const ticket=++generation;stopLiveLink('重新登录');status.value='connecting';lastError.value='';try{await setPushIdentity(null,()=>ticket===generation);const verified=await client.signIn(email,otp);if(ticket===generation)rememberEmail(email);return await identity(ticket,verified);}catch(e){if(ticket===generation){status.value='anonymous';lastError.value=explain(e);}return false;}}
 async function login(email:string,otp:string){
  if(loginFlight)return loginFlight;
  const work=loginOnce(email,otp);loginFlight=work;
  try{return await work;}finally{if(loginFlight===work)loginFlight=null;}
 }
 async function restore(force=false){
  if(!force&&user.value&&!businessReady.value&&(authorityFlight||authorityWanted||businessRecoveryWanted||authorityRecovery.waiting)){
   if(authorityFlight)await authorityFlight;else if(authorityWanted)onUnauthorized();else if(authorityRecovery.ready())await connectBusiness(generation,user.value.username);return businessReady.value;
  }
  if(!force&&user.value&&businessReady.value){
   if(status.value==='recovering'&&!authorityFlight)onUnauthorized();
   if(authorityFlight)await authorityFlight;
   return !!user.value&&['online','offline'].includes(status.value);
  }
  if(loginFlight)return loginFlight;
  if(restoreFlight)return restoreFlight;
  const ticket=user.value?generation:++generation;
  const work=restoreWithRetry(ticket);restoreFlight=work;
  try{return await work;}finally{if(restoreFlight===work)restoreFlight=null;}
 }
 async function restoreOnce(ticket:number){
  restoreRateLimited=false;
  try{localStorage.removeItem('qn.session');}catch{/* Legacy local storage is not the native login credential. */}
  try{return await (user.value&&memberVerifiedAt&&Date.now()-memberVerifiedAt<60000?connectBusiness(ticket,user.value.username):identity(ticket));}catch(e){if(ticket===generation){
   restoreRateLimited=e instanceof NativeError&&e.status===429;
   const authLost=e instanceof NativeError&&e.status===401&&e.code!=='session_changed';
   const denied=e instanceof NativeError&&e.status===403;
   if(authLost||denied){expireConfirmed();status.value=denied?'unbound':'anonymous';}else{status.value='recovering';if(user.value){authorityWanted=true;authorityRecovery.failed();}}
   if(!authLost)lastError.value=explain(e);
  }return false;}finally{ready.value=true;}
 }
 async function restoreWithRetry(ticket:number){
  for(const delay of [0,800,2000]){
   if(ticket!==generation)return false;
   if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
   if(ticket!==generation)return false;
   if(await restoreOnce(ticket))return true;
   if(ticket!==generation||status.value!=='recovering'||!isOnline()||restoreRateLimited||user.value)return false;
  }
  return false;
 }
 async function reconnect(){transportAuthFailures=0;transportAuthWindow=Date.now();if(user.value&&businessReady.value&&link.value.state!=='stopped'){pokeLiveLink();return;}await restore(true);}
 function retryPushBinding(ticket:number){
  if(ticket!==generation||isAndroidNative()||typeof Notification==='undefined'||Notification.permission!=='granted')return;
  pushRetryTicket=ticket;pushRecovery.failed();
 }
 const pushRecovery=createRecoveryGate({base:5000,wake:()=>{
  if(pushRetryTicket===generation&&businessReady.value&&isOnline())void syncPushBinding(false,true);
 }});
 function syncPushBinding(requestPermission=true,force=false):Promise<boolean>{
  if(isDesktopNative()){pushBound.value=false;pushReason.value='电脑客户端运行时通过实时连接接收消息';return Promise.resolve(false);}
  const ticket=generation;
  if(!businessReady.value||!user.value)return Promise.resolve(false);
  if(pushFlight?.ticket===ticket){if(force)pushRecheckTicket=ticket;return pushFlight.work;}
  const native=isAndroidNative(),needsPermission=typeof Notification==='undefined'||Notification.permission!=='granted';
  if(!force&&!native&&pushCheckedAt&&Date.now()-pushCheckedAt<60000&&(pushBound.value||needsPermission))return Promise.resolve(pushBound.value);
  // Lifecycle/expiry events join the same failure deadline; force invalidates
  // a success cache, never the retry budget.
  if(!native&&!pushRecovery.ready())return Promise.resolve(false);
  const account=user.value.username,controller=new AbortController();
  const current=()=>ticket===generation&&businessReady.value&&user.value?.username===account;
  const valid=()=>current()&&!controller.signal.aborted;
  const timer=setTimeout(()=>controller.abort(new DOMException('通知登记超时','TimeoutError')),30000);
  const wait=<T>(operation:Promise<T>):Promise<T>=>waitForOperation(operation,controller.signal);
  let task:PendingPushRenewal|null=null;
  const work=(async()=>{
   try{
    if(!native){
     if(requestPermission)await wait(ensureNotificationPermission());if(!valid())return false;
     if(typeof Notification!=='undefined'&&Notification.permission==='granted'&&hasWebPushSupport()){
      const claimed=await claimPushTask(account,'page-'+crypto.randomUUID(),30000,controller.signal,valid,installationId.value);
      if(!valid())return false;
      if(!claimed.pending){if(claimed.waitUntil){pushRetryTicket=ticket;pushRecovery.defer(Math.max(1,claimed.waitUntil-Date.now()));return false;}throw Error('push_task_not_ready');}
      task=claimed.pending;
      // Durable intent exists before subscribe/bind, including an in-flight page close.
      // BackgroundSync sees the same lease and cannot duplicate this attempt.
      await wait(scheduleWorkerPushRetry(account,controller.signal,valid));if(!valid())return false;
     }
    }
    let sub=await wait(getPushSubscription(false,undefined,valid));if(!valid())return false;
    type BoundPush={push_bound:boolean;state:string;device:{installation_id:string;subscription_fingerprint?:string}};
    const owner=await wait(readPushIdentity());if(!valid())return false;
    const bind=(subscription:unknown=null,expected:string|null=null)=>wait(apiRequest<BoundPush>('POST','/business/v1/devices',{body:{installation_id:installationId.value,platform:devicePlatform(),subscription,expected_fingerprint:expected,diagnostic:pushDiagnostic()},idempotencyKey:'device-'+crypto.randomUUID(),signal:controller.signal}));
    const commit=()=>commitPushSubscription({signal:controller.signal,valid,expected:owner?.subscriptionFingerprint??null,readCurrent:()=>readCurrentPushSubscription(controller.signal),write:bind,readRevision:async()=>{
     const rows=await apiRequest<{devices:Array<{installation_id:string;subscription_fingerprint?:string|null}>}>('GET','/business/v1/devices',{signal:controller.signal});
     return rows.devices.find(d=>d.installation_id===owner?.installationId)?.subscription_fingerprint??null;
    }}) as Promise<BoundPush>;
    let result:BoundPush;
    try{result=sub?await commit():await bind();}catch(e){
     if(!(e instanceof ApiError)||e.status!==409||String(e.code)!=='push_subscription_expired'||!sub||!valid())throw e;
     sub=await wait(getPushSubscription(false,(e as ApiError&{rejectedSubscription?:unknown}).rejectedSubscription??sub.subscription,valid));if(!valid())return false;
     if(!sub)throw e;result=await commit();
    }
    const detail=lastPushAvailability();
    if(!valid())return false;
    const fingerprint=result.device.subscription_fingerprint;
    const accepted=task&&sub&&result.push_bound&&typeof fingerprint==='string'
     ?await wait(savePushRenewal(task,fingerprint,valid,task))
     :await wait(setPushIdentity({account,installationId:result.device.installation_id,subscriptionFingerprint:fingerprint},valid,owner??undefined));if(!valid())return false;
    if(accepted===false){pushRecheckTicket=ticket;return false;}
    pushBound.value=!!sub&&result.push_bound;
    pushReason.value=pushBound.value?'Web Push订阅已登记，系统显示待验证':detail.reason;
    if(task&&!pushBound.value){await failPushTask(task,{code:detail.code},current);task=null;}
    if(!native&&!pushBound.value&&detail.retryable){await wait(scheduleWorkerPushRetry(account,controller.signal,valid));if(!valid())return false;}
    pushCheckedAt=Date.now();
    if(pushBound.value||native){pushRecovery.completed();pushRetryTicket=null;}
    else if(detail.retryable||detail.code==='permission_default'&&typeof Notification!=='undefined'&&Notification.permission==='granted')retryPushBinding(ticket);
    else{pushRecovery.completed();pushRetryTicket=null;}
    return native?result.state==='bound':pushBound.value;
   }catch(e){if(task)await failPushTask(task,e,current);if(current()){if(!native){pushBound.value=false;pushCheckedAt=0;}pushReason.value='设备登记尚未完成：'+explain(e);if(!(e instanceof ApiError&&[401,403].includes(e.status)))retryPushBinding(ticket);}return false;}
   finally{clearTimeout(timer);}
  })();
  pushFlight={ticket,work};void work.finally(()=>{if(pushFlight?.work===work){pushFlight=null;if(pushRecheckTicket===ticket){pushRecheckTicket=null;if(current())void syncPushBinding(false,true);}}});return work;
 }

 return {restoreCachedWorkspace,status,user,ready,lastError,isMainControl,canPublishAnnouncement,counts,mode,pushBound,pushReason,installationId,link,businessReady,businessWritable,isAuthenticated,displayName,sendCode,login,restore,reconnect,onUnauthorized,syncPushBinding};
});

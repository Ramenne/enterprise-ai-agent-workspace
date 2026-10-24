import {CLIENT_RELEASE} from '@/app/release';
import {readPushIdentity,readPendingPushRenewal,savePushRenewal} from './webPushState';
import {waitForOperation} from './operationDeadline.mjs';
// Android uses its existing native transport; Web Push serves PWA only.
import { apiRequest, ApiError } from '@/api/client';
import { devicePlatform, hasWebPushSupport, isAndroidNative } from '@/session/installation';
import type { DevicePlatform } from '@/api/types';
export interface PushSubscriptionResult { platform: DevicePlatform; subscription: unknown; }
export const ANDROID_NO_PUSH_SUBSCRIPTION = 'Android 通过原生后台连接接收消息并触发系统通知';
let lastPushDetail = { available: false, reason: '未探测', code: 'unknown', retryable: false };
export function lastPushAvailability() { return lastPushDetail; }
function unavailable(code:string,reason:string,retryable=false){lastPushDetail={available:false,code,reason,retryable};return null;}
function urlBase64ToUint8Array(base64:string):Uint8Array {
 const raw=atob((base64+'='.repeat((4-base64.length%4)%4)).replace(/-/g,'+').replace(/_/g,'/'));
 return Uint8Array.from(raw,c=>c.charCodeAt(0));
}
export async function getWebPushConfig():Promise<{applicationServerKey:string;supported:boolean}|null>{
 try{
  const cfg=await apiRequest<{web_push?:{supported?:boolean;application_server_key?:string}}>('GET','/business/v1/push-config');
  const key=cfg.web_push?.application_server_key||'';
  if(!cfg.web_push?.supported||!key)return unavailable('config_missing','后台消息通知尚未配置');
  try{const bytes=urlBase64ToUint8Array(key);if(bytes.length!==65||bytes[0]!==4)throw Error();}
  catch{return unavailable('config_invalid','后台消息通知公钥配置无效');}
  return {applicationServerKey:key,supported:true};
 }catch(e){return unavailable('config_unavailable','暂时无法读取通知配置',!(e instanceof ApiError&&[401,403,404].includes(e.status)));}
}
let permissionFlight:Promise<NotificationPermission>|null=null;
export function ensureNotificationPermission():Promise<NotificationPermission>{
 if(typeof Notification==='undefined')return Promise.resolve('denied');
 if(Notification.permission!=='default')return Promise.resolve(Notification.permission);
 if(permissionFlight)return permissionFlight;
 // Invoke synchronously within the user gesture; concurrent consumers share it.
 try{
  const request=Notification.requestPermission();
  const work=Promise.resolve(request).catch(()=>Notification.permission).finally(()=>{if(permissionFlight===work)permissionFlight=null;});
  permissionFlight=work;return work;
 }catch{return Promise.resolve(Notification.permission);}
}
async function bounded<T>(work:Promise<T>):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('TimeoutError')),15000);})]);}
 finally{clearTimeout(timer);}
}
export async function getWebPushSubscription(requestPermission=true,config?:Awaited<ReturnType<typeof getWebPushConfig>>,rejected?:unknown,valid=()=>true):Promise<PushSubscription|null>{
 if(!hasWebPushSupport())return unavailable('unsupported','当前浏览器不支持后台消息通知');
 // Request permission while still in the user's gesture, before any network wait.
 const permission=requestPermission?await ensureNotificationPermission():Notification.permission;
 if(permission!=='granted')return unavailable('permission_'+permission,permission==='denied'?'系统通知权限已关闭':'尚未允许系统通知');
 let reg:ServiceWorkerRegistration;
 try{reg=await bounded(navigator.serviceWorker.ready);}
 catch{return unavailable('worker_unavailable','消息通知服务尚未就绪',true);}
 try{
  const existing=await bounded(reg.pushManager.getSubscription());
  if(existing){
   const old=rejected as PushSubscriptionJSON|undefined,current=existing.toJSON();
   const matches=old?.endpoint===current.endpoint&&old?.keys?.auth===current.keys?.auth&&old?.keys?.p256dh===current.keys?.p256dh;
   if(!matches)return existing;
   if(!valid())return null;
   if(!await bounded(existing.unsubscribe()))return unavailable('subscription_replace_failed','通知订阅正在恢复，将自动重试',true);
  }
 }
 catch{return unavailable('subscription_read_failed','暂时无法读取通知订阅',true);}
 const cfg=config===undefined?await getWebPushConfig():config;if(!cfg?.supported||!valid())return null;
 try{return await bounded(reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlBase64ToUint8Array(cfg.applicationServerKey) as unknown as BufferSource}));}
 catch(e){
  const name=e instanceof Error?e.name:'';
  if(name==='NotAllowedError')return unavailable('subscription_denied','系统未允许创建通知订阅');
  if(name==='NotSupportedError')return unavailable('subscription_unsupported','当前浏览器不支持此通知订阅');
  if(name==='InvalidStateError')return unavailable('subscription_invalid_state','通知订阅状态异常，请重新打开员工客户端后重试',true);
  if(name==='AbortError')return unavailable('subscription_aborted','浏览器未能完成通知订阅，将自动重试',true);
  return unavailable('subscription_failed','消息通知订阅暂未成功，将自动重试',true);
 }
}
export async function getPushSubscription(requestPermission=true,rejected?:unknown,valid=()=>true):Promise<PushSubscriptionResult|null>{
 if(isAndroidNative())return unavailable('native_transport',ANDROID_NO_PUSH_SUBSCRIPTION);
 const sub=await getWebPushSubscription(requestPermission,undefined,rejected,valid);
 if(!sub)return null;
 lastPushDetail={available:true,reason:'',code:'ready',retryable:false};
 return {platform:devicePlatform(),subscription:sub.toJSON()};
}

// Keep first-registration failure durable too: a previous successful fingerprint
// is not required. Background Sync supplies browser-managed wakeups where supported.
export async function scheduleWorkerPushRetry(account:string,signal:AbortSignal,valid:()=>boolean):Promise<void>{
 if(typeof Notification==='undefined'||Notification.permission!=='granted'||!valid())return;
 try{
  const identity=await waitForOperation(readPushIdentity(),signal) as Awaited<ReturnType<typeof readPushIdentity>>;
  if(!valid()||identity?.account!==account)return;
  const pending=await waitForOperation(readPendingPushRenewal(),signal);
  if(!pending&&!await waitForOperation(savePushRenewal({identity},undefined,valid,'create'),signal)||!valid())return;
  const registration=await waitForOperation(navigator.serviceWorker.ready,signal) as ServiceWorkerRegistration & {sync?:{register:(tag:string)=>Promise<void>}};
  if(valid()&&registration.sync)await waitForOperation(registration.sync.register('qn-push-renewal'),signal);
 }catch{/* Foreground retry remains owned by the shared recovery gate. */}
}

export async function readCurrentPushSubscription(signal:AbortSignal):Promise<PushSubscription|null>{
 const registration=await waitForOperation(navigator.serviceWorker.ready,signal) as ServiceWorkerRegistration;
 return await waitForOperation(registration.pushManager.getSubscription(),signal) as PushSubscription|null;
}

export function pushDiagnostic(){
 const code=lastPushDetail.code,permission=typeof Notification==='undefined'?'unsupported':Notification.permission;
 const phase=code.startsWith('permission_')?'permission':code.startsWith('worker_')?'worker':code.startsWith('config_')?'config':code==='ready'?'ready':'subscription';
 return {client_version:CLIENT_RELEASE.versionCode,permission,phase,code};
}

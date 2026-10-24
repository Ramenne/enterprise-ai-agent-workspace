import {receiveNotificationEffect,retryNotificationEffects,scheduleNotificationEffects,nextNotificationEffectRetryAt} from './platform/workerNotificationEffects';
import {applyMessageBadge,restoreMessageBadge,nextBadgeRetryAt,scheduleBadgeEffects} from './platform/webBadge';
import {waitForOperation} from './platform/operationDeadline.mjs';
/// <reference lib="webworker" />
// src/sw.ts —— 员工客户端 Service Worker（injectManifest）：预缓存应用壳 + Web Push 接收 + 通知点击深链。
// 业务数据不在此缓存（由应用层按账号写入 IndexedDB）；hash 路由无需 SPA 导航回退。
// 推送载荷与后端 delivery.mjs 一致：{id, kind, title, summary, deep_link, priority, update_version}。
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { notificationRoutePath } from './platform/deeplink';
import {renewWorkerPush,scheduleWorkerPushRenewal,nextPushRenewalRetryAt} from './platform/workerPushRenewal';
import { clientsClaim } from 'workbox-core';
import { receiveWebPush, retireWebPush, matchesPushIdentity, readPushIdentity, readPendingPushRenewal, type PushMessage } from './platform/webPushState';

declare const self: ServiceWorkerGlobalScope;

// 应用壳与静态资源预缓存（__WB_MANIFEST 由 vite-plugin-pwa 注入；新版本激活时 autoUpdate 原子切换）。
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
// injectManifest needs an explicit activation lifecycle; config alone does not add it.
self.addEventListener('install', event => { event.waitUntil(self.skipWaiting()); });
clientsClaim();

// 稳定 Notification ID 去重：至少一次投递语义下，同一 id 合并为一条可见通知（tag 相同则替换）。
async function hidePush(tag:string,version?:number){for(const n of await self.registration.getNotifications())if((n.tag===tag||n.tag.startsWith(tag+':v'))&&(version===undefined||n.data?.update_version===version))n.close();}
async function displayPush(data:PushMessage){
 return await receiveWebPush(data,async(data,tag,alert)=>{
  const urgent = data.priority === 'urgent';
  const iconUrl = new URL('icons/icon-192.png', self.location.href).href;
  const options: NotificationOptions & {renotify:boolean} = {
    body: data.summary || '',
    icon: iconUrl,
    badge: iconUrl,
    tag:tag+':v'+data.update_version,
    silent: !alert,
    renotify: urgent && alert,
    requireInteraction: urgent,
    data: { deep_link: data.deep_link || '', id: data.id || '', kind: data.kind || '',object_type:data.object_type,object_id:data.object_id,project_id:data.project_id,snapshot:{conversation_peer:data.snapshot?.conversation_peer,work_item_id:data.snapshot?.work_item_id,project_id:data.snapshot?.project_id}, priority: data.priority || 'normal', account: data.recipient_username, installation_id: data.installation_id,update_version:data.update_version },
  };
  await self.registration.showNotification(data.title || '员工客户端', options);
  // Different versions cannot replace each other out of order in the OS queue.
  // Retain only newer/current versions; late old completion never closes newer.
  for(const n of await self.registration.getNotifications())if((n.tag===tag||n.tag.startsWith(tag+':v'))&&Number(n.data?.update_version||0)<data.update_version)n.close();

 },hidePush);
}
self.addEventListener('push',(event:PushEvent)=>{
 let data:PushMessage;try{data=event.data?.json();}catch{return;}
 event.waitUntil(Promise.all([receiveNotificationEffect(data,{registration:self.registration,display:displayPush,hide:hidePush}),retryPushRenewal(),...(data?.message_badge?[applyMessageBadge({account:data.recipient_username,installationId:data.installation_id},data.message_badge)]:[])]));
});
// Live SSE and server Web Push use the same worker queue and durable display journal.
self.addEventListener('message',event=>{
 if(event.data?.type==='qn-resume-notifications'||event.data?.type==='qn-resume-recovery'){
  const port=event.ports?.[0];
  event.waitUntil((async()=>{try{
   const signal=AbortSignal.timeout(25000);
   const client=event.source&&'id' in event.source?await waitForOperation(self.clients.get(event.source.id),signal):null;
   if(!client||new URL(client.url).origin!==self.location.origin)throw Error('untrusted_client');
   const identity=event.data.identity;
   if(identity?!await waitForOperation(matchesPushIdentity(identity.account,identity.installationId),signal):!!await waitForOperation(readPushIdentity(),signal)){port?.postMessage({ok:true,retryAt:null});return;}
   await waitForOperation(Promise.allSettled([
    retryNotificationEffects({registration:self.registration,display:displayPush,hide:hidePush}),
    (async()=>{if(await readPendingPushRenewal())await retryPushRenewal();})(),
    restoreMessageBadge(),
   ]),signal);
   await waitForOperation(Promise.all([scheduleNotificationEffects(self.registration),scheduleWorkerPushRenewal(self.registration,false),scheduleBadgeEffects(self.registration,false)]),signal);
   const deadlines=await waitForOperation(Promise.all([nextNotificationEffectRetryAt(),nextPushRenewalRetryAt(),nextBadgeRetryAt()]),signal) as Array<number|null>;
   const due=deadlines.filter((v):v is number=>v!==null);
   port?.postMessage({ok:true,retryAt:due.length?Math.min(...due):null});
  }catch{port?.postMessage({ok:false});}finally{port?.close();}})());return;
 }
 if(event.data?.type==='qn-message-badge'&&event.source&&'id' in event.source){const id=event.source.id;event.waitUntil((async()=>{const client=await self.clients.get(id);if(!client||new URL(client.url).origin!==self.location.origin)return;const {identity,snapshot}=event.data;if(identity&&snapshot)await applyMessageBadge(identity,snapshot);else await restoreMessageBadge();})());return;}

 if(event.data?.type==='qn-retire-chat'&&event.source&&'id' in event.source){
  const id=event.source.id;
  event.waitUntil((async()=>{const client=await self.clients.get(id);if(!client||new URL(client.url).origin!==self.location.origin)return;const messages=event.data.messages;if(!Array.isArray(messages)||messages.length>1000)return;await retireWebPush(messages,hidePush);})());return;
 }
 if(event.data?.type!=='qn-present-chat'||!event.source||!('id' in event.source))return;
 const id=event.source.id;
 const port=event.ports?.[0];
 event.waitUntil((async()=>{try{
  const client=await self.clients.get(id);if(!client||new URL(client.url).origin!==self.location.origin)throw Error('untrusted_client');
  const message=event.data.message;if(message?.kind!=='chat_message')throw Error('invalid_notice');
  const handled=await receiveNotificationEffect(message,{registration:self.registration,display:displayPush,hide:hidePush});port?.postMessage({ok:handled===true});
 }catch{port?.postMessage({ok:false});}finally{port?.close();}})());
});

// Browsers may rotate subscriptions while no app page is alive.
async function retryPushRenewal(change?:{newSubscription?:PushSubscription|null;oldSubscription?:PushSubscription|null},schedule=true){
 try{await renewWorkerPush(self.registration,change);}catch{/* Durable pending record retries on the next browser wake. */}
 if(schedule)await scheduleWorkerPushRenewal(self.registration);
}
self.addEventListener('pushsubscriptionchange',event=>{
 (event as ExtendableEvent).waitUntil((async()=>{
  await retryPushRenewal(event as ExtendableEvent & {newSubscription?:PushSubscription|null;oldSubscription?:PushSubscription|null});
  for(const client of await self.clients.matchAll({type:'window',includeUncontrolled:true}))client.postMessage({type:'qn-push-subscription-change'});
 })());
});
self.addEventListener('activate',event=>{event.waitUntil(Promise.all([retryPushRenewal(),restoreMessageBadge(),retryNotificationEffects({registration:self.registration,display:displayPush,hide:hidePush}).then(()=>scheduleNotificationEffects(self.registration))]));});
self.addEventListener('sync',event=>{const sync=event as ExtendableEvent & {tag:string};if(sync.tag==='qn-notification-effects')sync.waitUntil(retryNotificationEffects({registration:self.registration,display:displayPush,hide:hidePush}).then(done=>{if(!done)throw Error('notification_effect_pending');}));if(sync.tag==='qn-badge-effects')sync.waitUntil(restoreMessageBadge().then(async()=>{if(await nextBadgeRetryAt()!==null)throw Error('badge_effect_pending');}));if(sync.tag==='qn-push-renewal')sync.waitUntil((async()=>{await retryPushRenewal(undefined,false);if(await readPendingPushRenewal())throw Error('push_renewal_pending');})());});

// 深链只接受服务端受控对象路由（与客户端 platform/deeplink.ts 同一映射），不接受任意外部 URL。
// 服务端实际只下发五种深链（主线 `03-代码文档/当前实现/v8-v2/notify.mjs`）：
//   /api/v2/control/tasks/:id、/api/v2/me/tasks/:id、/api/v2/me/issues/:id、/api/v2/me/announcements、/api/v2/me/devices。
// 没有 plans 深链（object_type 只有 task/issue/announcement/device），因此不做 plan→task 的猜测映射。

self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  const route = notificationRoutePath(event.notification.data || {});
  const base = new URL('./', self.location.href).href;   // 应用基址（兼容子路径部署）
  const target = base + '#' + route;
  event.waitUntil((async () => {
    const identity = event.notification.data;
    if (!identity || !await matchesPushIdentity(identity.account, identity.installation_id)) return;
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // 应用已打开：聚焦并把深链交给页面路由（不自动已读，由用户明确操作）。
    for (const c of all) {
      if ('focus' in c) { await c.focus(); c.postMessage({ type: 'qn-deeplink', route }); return; }
    }
    // 冷启动：打开带 hash 的地址，应用启动恢复会话后由路由守卫回跳到该深链。
    if (self.clients.openWindow) return self.clients.openWindow(target);
    return undefined;
  })());
});

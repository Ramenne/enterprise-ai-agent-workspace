<script setup lang="ts">
import {isDesktopNative} from '@/platform/desktop';
import {syncPwaBadge} from '@/platform/pwaBadge';
import {createPwaNotificationEffectRecovery} from '@/platform/pwaNotificationEffects';

import {ref,onMounted,onBeforeUnmount,watch} from 'vue';
import {useRoute,useRouter} from 'vue-router';
import {useSessionStore} from '@/session/store';
import {useDataStore} from '@/store/data';
import {notificationRoutePath} from '@/platform/deeplink';
import {isAndroidNative} from '@/session/installation';
import {ensureNotificationPermission} from '@/platform/push';
import {useUiStore} from '@/store/ui';
import {bindPushPermissionRequest,bindPushRecovery} from '@/platform/pushRecovery.mjs';
import type {Notification} from '@/api/types';
import {retryPwaMessages,retirePwaMessages,closeDesktopNotifications} from '@/platform/pwaMessageAlerts';
import {readPushIdentity} from '@/platform/webPushState';
import {prepareMessageTone,playMessageTone} from '@/platform/messageTone.mjs';
import {soundEnabled} from '@/platform/localNotify';
const session=useSessionStore(),data=useDataStore(),router=useRouter(),route=useRoute(),ui=useUiStore();
const effectRecovery=createPwaNotificationEffectRecovery();
const permission=ref(typeof globalThis.Notification==='undefined'?'unsupported':globalThis.Notification.permission),enabling=ref(false),dismissed=ref(false);
function syncBadge(){if(!isAndroidNative())void syncPwaBadge(data.account===session.user?.username?data.account:'',data.account===session.user?.username?data.messageBadge:null);}
async function refreshPermission(changed=false){syncBadge();void retryPwaMessages();if(!isDesktopNative())void effectRecovery.wake();const previous=permission.value;permission.value=typeof globalThis.Notification==='undefined'?'unsupported':globalThis.Notification.permission;if(!isDesktopNative()&&permission.value==='granted'&&session.isAuthenticated)await session.syncPushBinding(false,changed||previous!==permission.value);}
async function enable(){if(isDesktopNative()){await globalThis.Notification.requestPermission();permission.value=globalThis.Notification.permission;void retryPwaMessages();return;}if(enabling.value)return;if(permission.value==='denied'){ui.openOverlay('notificationSettings');return;}enabling.value=true;try{await ensureNotificationPermission();permission.value=globalThis.Notification.permission;if(permission.value==='granted'){const ok=await session.syncPushBinding(false);ui.toast(ok?'消息通知已开启':'正在开启后台通知');}else ui.toast(permission.value==='denied'?'系统通知已关闭，可在通知设置中允许':'尚未允许系统通知，可再次点击开启');}finally{enabling.value=false;}}
const alerts=ref<Notification[]>([]),timers=new Set<ReturnType<typeof setTimeout>>();
function dismiss(id:string){alerts.value=alerts.value.filter(n=>n.id!==id);}
function arrived(event:Event){const {account,notice}= (event as CustomEvent).detail||{};if(isAndroidNative()||account!==session.user?.username||!notice?.id||notice.read_at||notice.hidden_at||notice.acked_at||alerts.value.some(n=>n.id===notice.id))return;if(soundEnabled()&&globalThis.Notification?.permission!=='granted')playMessageTone();alerts.value=[...alerts.value,notice].slice(-3);const timer=setTimeout(()=>{timers.delete(timer);dismiss(notice.id);},7000);timers.add(timer);}
function open(n:Notification){dismiss(n.id);void router.push(notificationRoutePath(n));}
watch(()=>session.user?.username,()=>{alerts.value=[];if(isDesktopNative())closeDesktopNotifications();});
watch(()=>[data.account,...data.notifications.map(n=>`${n.id}:${n.update_version}:${n.read_at}:${n.hidden_at}:${n.acked_at}`)],()=>{
 if(isAndroidNative())return;
 const owner=data.account,retired=data.notifications.filter(n=>n.kind==='chat_message'&&(n.read_at||n.hidden_at||n.acked_at));
 retirePwaMessages(owner,retired);alerts.value=alerts.value.filter(n=>!retired.some(row=>row.id===n.id));
 if(owner&&owner===session.user?.username&&retired.length)void (async()=>{
  const identity=await readPushIdentity();if(!identity||identity.account!==owner||owner!==session.user?.username||data.account!==owner)return;
  const registration=await navigator.serviceWorker?.getRegistration();
  (navigator.serviceWorker?.controller||registration?.active)?.postMessage({type:'qn-retire-chat',messages:retired.slice(-1000).map(n=>({id:n.id,update_version:n.update_version,recipient_username:owner,installation_id:identity.installationId}))});
 })().catch(()=>{});
},{immediate:true});
watch(()=>[session.user?.username,data.account,data.messageBadge],()=>{syncBadge();if(!isAndroidNative()&&session.isAuthenticated)if(!isDesktopNative())void effectRecovery.wake();},{immediate:true,deep:true});
let releaseTone:(()=>void)|undefined,releaseRecovery:(()=>void)|undefined,releasePermission:(()=>void)|undefined;
onMounted(()=>{if(!isAndroidNative()){releaseTone=prepareMessageTone();releaseRecovery=bindPushRecovery(refreshPermission);releasePermission=bindPushPermissionRequest({allowed:()=>session.isAuthenticated&&session.businessReady,isDefault:()=>globalThis.Notification?.permission==='default',request:ensureNotificationPermission,complete:()=>{void refreshPermission(true);}});}window.addEventListener('qn-pwa-chat-alert',arrived);});
onBeforeUnmount(()=>{effectRecovery.stop();releaseTone?.();releaseRecovery?.();releasePermission?.();window.removeEventListener('qn-pwa-chat-alert',arrived);for(const timer of timers)clearTimeout(timer);});
</script>
<template><div v-if="!isAndroidNative()&&session.isAuthenticated&&route.name==='conversations'&&!dismissed&&permission!=='unsupported'&&(permission!=='granted'||!isDesktopNative()&&!session.pushBound)" class="pwa-notification-optin"><button :disabled="enabling" @click="enable">{{enabling?'正在开启…':permission==='denied'?'允许系统通知，接收后台消息':permission==='granted'?'开启后台消息通知':'开启消息通知'}}</button><button aria-label="稍后开启通知" @click="dismissed=true">×</button></div><aside v-if="alerts.length" class="pwa-chat-alerts" aria-label="新聊天消息" aria-live="polite"><article v-for="n in alerts" :key="n.id"><button class="pwa-chat-open" @click="open(n)"><strong>{{n.title||'新消息'}}</strong><span>{{n.summary||'收到新消息'}}</span></button><button class="pwa-chat-dismiss" aria-label="关闭消息提醒" @click="dismiss(n.id)">×</button></article></aside></template>
<style scoped>
.pwa-notification-optin{position:fixed;bottom:calc(68px + env(safe-area-inset-bottom));right:12px;z-index:80;display:flex;max-width:calc(100vw - 24px);border:1px solid var(--line);border-radius:8px;background:var(--paper,#fff)}.pwa-notification-optin button{min-height:40px;border:0;background:transparent;color:var(--accent-dark);padding:8px 12px;font-size:13px}.pwa-chat-alerts{position:fixed;z-index:1200;top:max(12px,env(safe-area-inset-top));right:12px;width:min(340px,calc(100vw - 24px));display:grid;gap:8px}.pwa-chat-alerts article{display:flex;background:var(--paper,#fff);border:1px solid var(--line,#ddd);border-radius:10px;box-shadow:0 3px 12px #0002;overflow:hidden}.pwa-chat-open{flex:1;min-width:0;text-align:left;border:0;background:transparent;color:var(--ink);padding:12px}.pwa-chat-open strong,.pwa-chat-open span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pwa-chat-open span{font-size:14px;margin-top:4px;color:var(--muted)}.pwa-chat-dismiss{align-self:start;min-width:40px;min-height:40px;border:0;background:transparent;color:var(--muted);font-size:22px}
</style>

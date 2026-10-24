<script setup lang="ts">
import {createReadFeedback} from '@/domain/readFeedback.mjs';
import AndroidBackgroundAccess from '@/ui/components/AndroidBackgroundAccess.vue';
import {ref,onMounted,onBeforeUnmount,watch} from 'vue';
import {desktopBridge} from '@/platform/desktop';
import {checkDesktopUpdate,hasAppUpdate} from '@/platform/updateAvailability';
import {useUiStore} from '@/store/ui';
import {useRouter} from 'vue-router';
import {useSessionStore} from '@/session/store';
import {restoredRoute} from '@/app/restore-route.mjs';
import {routeFromTarget,deepTargetQuery,type DeepTarget} from '@/platform/deeplink';
import {onLocalNotificationOpened} from '@/platform/localNotify';
import SplashScreen from '@/ui/components/SplashScreen.vue';
import OverlayHost from '@/ui/components/OverlayHost.vue';
import PwaChatAlerts from '@/ui/components/PwaChatAlerts.vue';
import ToastHost from '@/ui/components/ToastHost.vue';
const session=useSessionStore(),router=useRouter(),ui=useUiStore();
const offDesktopSettings=desktopBridge()?.onOpenSettings?.(page=>{if(page==='settings'&&session.isAuthenticated)void router.push({name:'profile'});else {ui.openOverlay('about');if(page==='updates'&&!hasAppUpdate.value)void checkDesktopUpdate(true).catch(()=>{});}});
onBeforeUnmount(()=>offDesktopSettings?.());
const routeReady=ref(session.ready&&session.isAuthenticated),recoveryError=ref('');let disposed=false;
const recoveryFeedback=createReadFeedback({publish:(text:string)=>recoveryError.value=text,emptyGraceMs:30000});
let recoveryTimer:ReturnType<typeof setTimeout>|undefined,recoveryAttempt=0;
function cancelRecovery(){clearTimeout(recoveryTimer);recoveryTimer=undefined;}
function scheduleRecovery(){
 cancelRecovery();if(disposed||session.status!=='recovering'||document.visibilityState==='hidden'||!navigator.onLine)return;
 recoveryTimer=setTimeout(()=>{recoveryTimer=undefined;void restoreAndRoute();},Math.min(60000,15000*2**Math.min(recoveryAttempt++,2)));
}
function go(target:DeepTarget|null){if(target)void router.push({name:target.name,params:target.params,query:deepTargetQuery(target)});}
function onSwMessage(e:MessageEvent){
 const d=e.data as {type?:string;route?:string}|undefined;
 if(d?.type==='qn-deeplink'&&d.route&&/^\/(?!\/)/.test(d.route))void router.push(d.route);
}
let offLocalNotify:(()=>void)|null=null;
async function restoreAndRoute(){
 cancelRecovery();const cold=!session.isAuthenticated;if(cold)routeReady.value=false;recoveryFeedback.begin(!cold);
 try{
  await session.restore();if(disposed)return;
  if(session.status==='recovering'&&!session.isAuthenticated){recoveryFeedback.failed({code:'network'},'暂未连接服务，正在重试');scheduleRecovery();return;}
  if(session.status==='recovering')scheduleRecovery();else recoveryAttempt=0;
  await router.isReady();
  if(session.isAuthenticated&&router.currentRoute.value.name==='connect')await router.replace(restoredRoute(router.currentRoute.value.query.redirect));
  if(!disposed){routeReady.value=true;recoveryFeedback.succeeded();}
 }catch(e){if(!disposed){recoveryFeedback.failed(e,'暂未读取工作区，请重试');scheduleRecovery();}}
}
function resumeRecovery(){if(session.status==='recovering'&&document.visibilityState!=='hidden')void restoreAndRoute();}
onMounted(()=>{
 navigator.serviceWorker?.addEventListener('message',onSwMessage);
 window.addEventListener('online',resumeRecovery);document.addEventListener('visibilitychange',resumeRecovery);
 offLocalNotify=onLocalNotificationOpened(t=>go(routeFromTarget(t)));
 void (async()=>{
  if(await session.restoreCachedWorkspace()){
   await router.isReady();if(disposed)return;
   if(router.currentRoute.value.name==='connect')await router.replace(restoredRoute(router.currentRoute.value.query.redirect));
   routeReady.value=true;
  }
  if(!disposed)void restoreAndRoute();
 })();
});
watch(()=>session.status,status=>{
 if(status!=='recovering'){cancelRecovery();recoveryFeedback.succeeded();}
 if(['expired','unbound'].includes(status)&&routeReady.value&&router.currentRoute.value.name!=='connect')void router.replace({name:'connect',query:{redirect:router.currentRoute.value.fullPath}});
});
onBeforeUnmount(()=>{disposed=true;recoveryFeedback.dispose();cancelRecovery();navigator.serviceWorker?.removeEventListener('message',onSwMessage);window.removeEventListener('online',resumeRecovery);document.removeEventListener('visibilitychange',resumeRecovery);offLocalNotify?.();});
</script>
<template><div class="app-root"><SplashScreen v-if="!session.ready||!routeReady" :error="recoveryError" @retry="restoreAndRoute"/><router-view v-else/><OverlayHost/><ToastHost/><PwaChatAlerts/><AndroidBackgroundAccess/></div></template>

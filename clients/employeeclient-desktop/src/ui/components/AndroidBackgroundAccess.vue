<script setup lang="ts">
import {ref,onMounted,onBeforeUnmount} from 'vue';
import {App} from '@capacitor/app';
import {useRoute} from 'vue-router';
import {useUiStore} from '@/store/ui';
import {isAndroidNative} from '@/session/installation';
import {backgroundAccess} from '@/platform/backgroundAccess';
const route=useRoute(),ui=useUiStore(),needed=ref(false),dismissed=ref(false);
let listener:{remove:()=>Promise<void>}|undefined,disposed=false;
async function check(){if(!isAndroidNative())return;try{const state=await backgroundAccess();if(!disposed)needed.value=!!state&&(!state.batteryUnrestricted||!state.notifications||state.chatChannelImportance>=0&&state.chatChannelImportance<4);}catch{}}
onMounted(async()=>{await check();if(!isAndroidNative())return;const handle=await App.addListener('resume',check);if(disposed)await handle.remove();else listener=handle;});
onBeforeUnmount(()=>{disposed=true;void listener?.remove();});
</script>
<template><div v-if="needed&&!dismissed&&route.name==='conversations'" class="background-access"><button @click="ui.openOverlay('notificationSettings')">完善后台接收设置</button><button aria-label="稍后设置后台接收" @click="dismissed=true">×</button></div></template>
<style scoped>.background-access{display:flex;position:fixed;bottom:calc(68px + env(safe-area-inset-bottom));right:12px;z-index:80;border:1px solid var(--line);border-radius:8px;background:var(--paper)}button{min-height:40px;border:0;background:transparent;color:var(--accent-dark);padding:8px 12px;font-size:13px}</style>

<script setup lang="ts">
import {ref,computed,nextTick,onDeactivated,watch} from 'vue';
import AppIcon from './AppIcon.vue';
const props=defineProps<{refresh:()=>Promise<unknown>;busy?:boolean;error?:string;label?:string}>();
const root=ref<HTMLElement|null>(null),distance=ref(0),running=ref(false),failed=ref(false);
// A background read/initial load is not a user pull gesture.
const loading=computed(()=>running.value);
const blocked=computed(()=>running.value||props.busy);
let attempt=0;
watch(()=>props.error,value=>{if(!value)failed.value=false;});
let start:{x:number;y:number}|null=null;
function atTop(){let node=root.value?.parentElement;while(node){if(/auto|scroll/.test(getComputedStyle(node).overflowY)&&node.scrollHeight>node.clientHeight)return node.scrollTop<=0;node=node.parentElement;}return (document.scrollingElement?.scrollTop||0)<=0;}
function begin(event:TouchEvent){start=null;distance.value=0;if(event.touches.length!==1||blocked.value||!atTop()||(event.target as Element)?.closest('input,textarea,select,[role="dialog"]'))return;start={x:event.touches[0].clientX,y:event.touches[0].clientY};}
function move(event:TouchEvent){if(!start)return;const touch=event.touches[0];if(!touch)return;const dx=touch.clientX-start.x,dy=touch.clientY-start.y;if(Math.abs(dx)>Math.abs(dy)&&Math.abs(dx)>8){start=null;return;}if(dy<=0||!atTop()){distance.value=0;return;}if(event.cancelable)event.preventDefault();distance.value=Math.min(90,dy*.5);}
async function refresh(){if(blocked.value)return;const ticket=++attempt;start=null;distance.value=0;running.value=true;failed.value=false;try{await props.refresh();await nextTick();if(ticket===attempt)failed.value=false;}catch{if(ticket===attempt)failed.value=props.error===undefined;}finally{if(ticket===attempt)running.value=false;}}
function end(){const trigger=distance.value>=54;start=null;distance.value=0;if(trigger)void refresh();}
function cancel(){start=null;distance.value=0;}
onDeactivated(()=>{cancel();attempt++;running.value=false;failed.value=false;});
</script>
<template>
 <section ref="root" class="pull-refresh" @touchstart.passive="begin" @touchmove="move" @touchend="end" @touchcancel="cancel">
  <div v-show="loading||failed||distance" class="refresh-indicator" :class="{loading}" :style="{height:loading||failed? '40px':distance+'px'}" :aria-hidden="!loading&&!failed&&!distance">
   <AppIcon v-if="loading||distance" name="refresh"/><span v-if="loading" role="status">正在刷新…</span><button v-else-if="failed" class="refresh-retry" @click="refresh">刷新未完成 · 重试</button><span v-else-if="distance">{{distance>=54?'松开刷新':'下拉刷新'}}</span>
  </div>
  <button class="refresh-accessible" :aria-label="label||'刷新列表'" :disabled="blocked" @click="refresh">刷新</button>
  <slot/>
 </section>
</template>
<style scoped>
.pull-refresh{position:relative;min-width:0}.refresh-indicator{display:flex;align-items:center;justify-content:center;gap:8px;color:var(--muted);font-size:12px;overflow:hidden;transition:height .16s ease}.refresh-indicator .icon{width:16px;height:16px}.refresh-indicator.loading .icon{animation:refresh-spin 1s linear infinite}.refresh-retry{border:0;background:transparent;color:var(--blue);min-height:40px;padding:0 12px}.refresh-accessible{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);border:0;padding:0}.refresh-accessible:focus-visible{position:static;width:auto;height:36px;clip-path:none;padding:0 12px;color:var(--blue);background:transparent}@keyframes refresh-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.refresh-indicator.loading .icon{animation:none}}
</style>

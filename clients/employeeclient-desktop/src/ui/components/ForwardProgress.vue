<script setup lang="ts">
import {ref,watch,onBeforeUnmount} from 'vue';
const props=defineProps<{busy:boolean;completed?:number;total?:number;label?:string}>();
const delayed=ref(false);let timer:ReturnType<typeof setTimeout>|undefined;
watch(()=>props.busy,value=>{clearTimeout(timer);delayed.value=false;if(value)timer=setTimeout(()=>delayed.value=true,5000);},{immediate:true});onBeforeUnmount(()=>clearTimeout(timer));
</script>
<template><span v-if="busy" class="forward-progress" role="status" :aria-label="label||'正在转发'"><i aria-hidden="true"></i><span v-if="delayed">{{total&&total>1?`正在转发 ${Math.min(completed||0,total)} / ${total}`:(label||'正在转发，请稍候')}}</span></span></template>
<style scoped>
.forward-progress{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:24px;font-size:13px;color:var(--muted)}.forward-progress i{width:15px;height:15px;border:1.5px solid #d1d1d1;border-top-color:#777;border-radius:50%;animation:qn-spin .8s linear infinite}@media(prefers-reduced-motion:reduce){.forward-progress i{animation:none}}
</style>

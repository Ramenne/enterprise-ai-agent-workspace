<script setup lang="ts">
import {computed} from 'vue';
const props=defineProps<{value?:number;label?:string}>();
const percent=computed(()=>props.value===undefined?undefined:Math.max(0,Math.min(100,Math.floor(props.value))));
</script>
<template><span class="transfer-sector" :class="{waiting:percent===undefined}" :style="percent===undefined?undefined:{'--transfer-angle':percent*3.6+'deg'}" role="progressbar" :aria-label="label||'正在传输'" :aria-valuenow="percent" aria-valuemin="0" aria-valuemax="100"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17V6m-4 4 4-4 4 4M5 16v4h14v-4"/></svg></span></template>
<style scoped>
.transfer-sector{display:inline-grid;place-items:center;position:relative;flex:none;width:38px;height:38px;border-radius:50%;border:1px solid #ffffffb3;background:conic-gradient(#ffffffd9 var(--transfer-angle,0deg),#0006 0);box-shadow:0 1px 4px #0002;overflow:hidden}
.transfer-sector svg{position:relative;width:19px;height:19px;fill:none;stroke:#176a49;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.transfer-sector.waiting:before{content:'';position:absolute;inset:0;border-radius:50%;background:conic-gradient(#fffd 80deg,#0006 0);animation:sector-spin 1.1s linear infinite}
@keyframes sector-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.transfer-sector.waiting:before{animation:none}}
</style>

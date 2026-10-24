<script setup lang="ts">
import {ref,onBeforeUnmount} from 'vue';
defineProps<{number:string}>();const emit=defineEmits<{open:[]}>(),pressed=ref(false);let timer:ReturnType<typeof setTimeout>|undefined;
function open(){if(timer)return;pressed.value=true;timer=setTimeout(()=>{timer=undefined;emit('open');pressed.value=false;},100);}onBeforeUnmount(()=>clearTimeout(timer));
</script>
<template><button type="button" class="reference-number" :class="{pressed}" @click.stop="open">{{number}}</button></template>
<style scoped>.reference-number{display:inline-block;width:auto;min-width:0;min-height:0;border:0;border-radius:4px;padding:2px 4px;background:#e5f2ed;color:#237b62;font:inherit;font-weight:550;line-height:1.5;white-space:nowrap;touch-action:manipulation;transition:background-color .08s}.reference-number:active,.reference-number.pressed{background:#b9ddcd;color:#145e48}.reference-number:focus-visible{outline:2px solid #26746a;outline-offset:2px}</style>

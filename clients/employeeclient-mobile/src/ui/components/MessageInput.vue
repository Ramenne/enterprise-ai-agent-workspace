<script setup lang="ts">
import {onMounted,onBeforeUnmount,ref} from 'vue';
// Shared by group chat and the embedded Agent conversation. The native element
// remains available to their existing focus/voice/viewport controllers.
const model=defineModel<string>({default:''});
const element=ref<HTMLTextAreaElement|null>(null);
const emit=defineEmits<{element:[value:HTMLTextAreaElement|null]}>();
onMounted(()=>emit('element',element.value));
onBeforeUnmount(()=>emit('element',null));
</script>
<template><textarea ref="element" v-model="model" class="message-input" rows="1" /></template>
<style scoped>
.message-input{display:block;box-sizing:border-box;flex:1;min-width:0;width:0;height:48px;min-height:48px;max-height:112px;margin:0;resize:none;line-height:24px;border:1px solid var(--control-line);border-radius:8px;background:var(--paper);color:var(--ink);padding:10px 12px;box-shadow:none;font:inherit;font-size:var(--message-font-size);line-height:26px}
.message-input:focus,.message-input:focus-visible{outline:none;box-shadow:none;border-color:#aeb8c3}
</style>

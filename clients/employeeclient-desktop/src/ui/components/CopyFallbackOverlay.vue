<script setup lang="ts">
// 复制兜底：浏览器未允许直接复制时，展示可手动全选的交接文本。
import { useUiStore } from '@/store/ui';
import ModalSheet from '@/ui/components/ModalSheet.vue';
const ui = useUiStore();
const props = ui.overlayProps as { text: string };
</script>
<template>
  <ModalSheet title="交接信息" sub="当前浏览器未允许直接复制，可手动全选下面的内容" @close="ui.closeOverlay()">
    <textarea class="input" aria-label="可复制的交接信息" readonly style="min-height:280px" :value="props.text"></textarea>
    <template #footer><button class="btn primary" @click="ui.closeOverlay()">关闭</button></template>
  </ModalSheet>
</template>

<script setup lang="ts">
// 通用底部抽屉弹层（移动端）：标题/副标题/关闭 + 内容插槽 + 页脚插槽。所有覆盖层复用它，保证一致交互。
import AppIcon from './AppIcon.vue';
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { useModalFocus } from './modalFocus';
const panel = ref<HTMLElement | null>(null);
const viewportHeight = ref(window.visualViewport?.height || window.innerHeight);
const viewportTop = ref(window.visualViewport?.offsetTop || 0);
function resize() { viewportHeight.value = window.visualViewport?.height || window.innerHeight; viewportTop.value = window.visualViewport?.offsetTop || 0; }
onMounted(() => { window.addEventListener('resize', resize); window.visualViewport?.addEventListener('resize', resize); window.visualViewport?.addEventListener('scroll', resize); });
onBeforeUnmount(() => { window.removeEventListener('resize', resize); window.visualViewport?.removeEventListener('resize', resize); window.visualViewport?.removeEventListener('scroll', resize); });
defineProps<{ title: string; sub?: string; wide?: boolean; modalClass?: string; back?: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();
useModalFocus(panel, () => emit('close'));
</script>

<template>
  <div class="overlay" :style="{height: viewportHeight + 'px', top: viewportTop + 'px', bottom: 'auto'}" @click.self="emit('close')">
    <section ref="panel" tabindex="-1" class="modal" :class="[{ wide }, modalClass]" role="dialog" aria-modal="true" :aria-label="title">
      <header class="modal-header">
        <div class="modal-title"><h2>{{ title }}</h2><p v-if="sub">{{ sub }}</p></div>
        <button class="icon-btn" :aria-label="back?'返回':'关闭'" @click="emit('close')"><AppIcon :name="back?'back':'close'" /></button>
      </header>
      <div class="modal-body"><slot /></div>
      <footer v-if="$slots.footer" class="modal-footer"><slot name="footer" /></footer>
    </section>
  </div>
</template>

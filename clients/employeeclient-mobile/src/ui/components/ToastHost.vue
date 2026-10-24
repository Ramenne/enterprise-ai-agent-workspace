<script setup lang="ts">
import { useUiStore } from '@/store/ui';
import AppIcon from './AppIcon.vue';
const ui = useUiStore();
</script>
<template>
  <TransitionGroup id="toast-area" name="qn-toast" tag="div" aria-live="polite" aria-atomic="false">
    <div v-for="t in ui.toasts" :key="t.id" class="toast" :class="{ error: t.error, attention: t.attention }" :role="t.error ? 'alert' : 'status'">
      <AppIcon :name="t.error || t.attention ? 'info' : 'check'" /><span>{{ t.msg }}</span>
    </div>
  </TransitionGroup>
</template>

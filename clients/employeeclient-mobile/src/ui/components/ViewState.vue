<script setup lang="ts">
import AppIcon from './AppIcon.vue';
withDefaults(defineProps<{ kind?: 'loading' | 'empty' | 'error' | 'restricted'; title: string; description?: string; action?: string; busy?: boolean }>(), { kind: 'empty' });
defineEmits<{ action: [] }>();
</script>
<template>
  <section class="view-state" :class="`view-state-${kind}`" :role="kind === 'error' ? 'alert' : 'status'" :aria-busy="kind === 'loading' || busy">
    <span class="view-state-icon"><AppIcon :name="kind === 'error' ? 'wifi' : kind === 'restricted' ? 'lock' : kind === 'loading' ? 'refresh' : 'inbox'" /></span>
    <h2>{{ title }}</h2><p v-if="description">{{ description }}</p>
    <button v-if="action" class="btn soft" :disabled="busy" @click="$emit('action')">{{ action }}</button>
  </section>
</template>
<style scoped>
.view-state{display:grid;justify-items:center;gap:12px;padding:36px 24px;text-align:center;color:var(--muted);background:var(--paper);border:1px solid var(--line);border-radius:var(--radius)}.view-state h2{margin:0;color:var(--ink);font-size:18px;line-height:1.5}.view-state p{max-width:38em;font-size:14px;line-height:1.8;margin:0;overflow-wrap:anywhere}.view-state-icon{display:grid;place-items:center;width:48px;height:48px;background:var(--paper-soft);border-radius:14px;color:var(--accent)}.view-state-error .view-state-icon{background:var(--red-soft);color:var(--red)}
</style>

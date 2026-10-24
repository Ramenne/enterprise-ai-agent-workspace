<script setup lang="ts">
import { worklogLabel } from '@/domain/agentHandoff';
defineProps<{ id?: number | null }>();
</script>
<template><span v-if="worklogLabel(id)" class="worklog-number">{{ worklogLabel(id) }}</span></template>
<style scoped>
.worklog-number { display: inline; margin-inline-end: .45em; color: var(--muted, #687976); font-size: .88em; font-variant-numeric: tabular-nums; white-space: nowrap; }
</style>

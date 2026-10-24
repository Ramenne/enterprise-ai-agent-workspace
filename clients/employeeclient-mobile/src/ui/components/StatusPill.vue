<script setup lang="ts">
import type { Label } from '@/ui/format';
defineProps<{ label: Label }>();
</script>
<template>
  <span class="status" :class="label.tone">{{ label.text }}</span>
</template>

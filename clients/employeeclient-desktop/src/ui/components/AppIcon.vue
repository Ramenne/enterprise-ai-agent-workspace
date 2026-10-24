<script setup lang="ts">
import { ICON_PATHS } from '@/ui/icons';
const props = defineProps<{ name: string }>();
</script>
<template>
  <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
    <path :d="ICON_PATHS[props.name] || ICON_PATHS.doc" />
  </svg>
</template>

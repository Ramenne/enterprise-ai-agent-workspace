<script setup lang="ts">
import WorklogNumber from '@/ui/components/WorklogNumber.vue';
// 任务行（收件箱/项目/审核共用）：图标随节点/紧急度变化，右侧状态 + 相对时间。只读展示，不写回状态。
import { computed } from 'vue';
import type { Task } from '@/api/types';
import { taskDisplayState, ago } from '@/ui/format';
import AppIcon from './AppIcon.vue';
import StatusPill from './StatusPill.vue';

const props = defineProps<{ task: Task; projectName?: string; urgent?: boolean; reviewMode?: boolean }>();
const emit = defineEmits<{ (e: 'open', t: Task): void }>();

const state = computed(() => taskDisplayState(props.task));
const iconName = computed(() => props.urgent ? 'bolt'
  : props.task.current_node.includes('plan') ? 'doc'
    : props.task.current_node.includes('code') ? 'code' : 'check');
const iconTone = computed(() => props.urgent ? 'red'
  : props.task.current_node.includes('revision') ? 'amber'
    : props.task.main_state === 'completed' ? 'teal'
      : props.task.scope_at_creation === 'personal' ? 'teal' : 'blue');
</script>

<template>
  <button class="task-row pressable" @click="emit('open', task)">
    <span class="row-icon" :class="iconTone"><AppIcon :name="iconName" /></span>
    <span class="row-body">
      <span class="row-title">{{ task.title }}</span>
      <span class="row-info">
        <span v-if="task.scope_at_creation === 'personal'" class="tiny-icon"><AppIcon name="lock" /></span>
        <span>{{ projectName || task.project_id.slice(0, 10) }}</span>
        <WorklogNumber v-if="task.scope_at_creation === 'company'" :id="task.latest_worklog_id" />
      </span>
    </span>
    <span class="row-meta">
      <span v-if="urgent" class="status red"><AppIcon name="bolt" />已催促</span>
      <StatusPill v-else :label="state" />
      <span>{{ ago(task.updated_at) }}</span>
    </span>
  </button>
</template>

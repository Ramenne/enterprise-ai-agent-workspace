<script setup lang="ts">
import WorklogNumber from '@/ui/components/WorklogNumber.vue';
// 问题行（公司反馈 / 个人项目共用）：类型图标、标题、摘要、提交人、状态/严重程度/时间。只读展示。
import { computed } from 'vue';
import type { Issue } from '@/api/types';
import { issueStateLabel, SEVERITY_LABEL, ago, intakeKindLabel } from '@/ui/format';
import AppIcon from './AppIcon.vue';
import StatusPill from './StatusPill.vue';

const props = defineProps<{ issue: Issue; submitterName?: string; claimSummary?: string }>();
const emit = defineEmits<{ (e: 'open', i: Issue): void }>();
const personal = computed(() => (props.issue.scope || 'company') === 'personal');
const isIdea = computed(() => props.issue.intake_kind === 'plan_idea');
const state = computed(() => issueStateLabel(props.issue));
</script>

<template>
  <button class="task-row issue-row pressable" @click="emit('open', issue)">
    <span class="row-icon" :class="personal && isIdea ? 'violet' : 'amber'"><AppIcon :name="personal && isIdea ? 'sparkles' : 'message'" /></span>
    <span class="row-body">
      <span class="row-title">{{ issue.title }}</span>
      <span class="row-description">{{ issue.detail || '还没有补充说明' }}</span>
      <span class="row-info">
        <template v-if="personal && issue.intake_kind"><span>{{ intakeKindLabel(issue.intake_kind) }}</span><i class="small-dot"></i></template>
        <span>{{ submitterName || issue.submitter_username }}提出</span><WorklogNumber v-if="!personal" :id="issue.latest_worklog_id" />
      </span>
      <span v-if="claimSummary" class="claim-summary"><AppIcon name="users" />{{ claimSummary }}</span>
    </span>
    <span class="row-meta">
      <StatusPill :label="state" />
      <span>{{ SEVERITY_LABEL[issue.severity] }}</span>
      <span>{{ ago(issue.created_at) }}</span>
    </span>
  </button>
</template>

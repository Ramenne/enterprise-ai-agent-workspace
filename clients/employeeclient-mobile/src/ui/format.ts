// src/ui/format.ts —— 展示格式化：把后端权威枚举/毫秒时间戳映射为已通过 UI 的中文标签与颜色。
// 只影响展示，不写回任何业务状态。
import {fullDate,fullDateTime} from './date.mjs';
import type { Task, Issue, CodeVersion, NotificationKind, IssueSeverity } from '@/api/types';

export type Tone = 'green' | 'blue' | 'amber' | 'red' | 'gray' | 'violet' | 'teal';
export interface Label { text: string; tone: Tone }

// Task 展示态：由 main_state + current_node 推导（后端不存“展示态”，客户端不写回）。
export function taskDisplayState(t: Task): Label {
  if (t.main_state === 'completed') return { text: '已完成', tone: 'gray' };
  if (t.main_state === 'cancelled') return { text: '已取消', tone: 'gray' };
  if (t.main_state === 'paused') return { text: '已暂停', tone: 'amber' };
  switch (t.current_node) {
    case 'awaiting_plan_review': return { text: '待策划审核', tone: 'blue' };
    case 'awaiting_plan_revision': return { text: '策划需修改', tone: 'amber' };
    case 'awaiting_code': return { text: '待代码提交', tone: 'green' };
    case 'awaiting_code_review': return { text: '待代码审核', tone: 'blue' };
    case 'awaiting_code_revision': return { text: '代码需修改', tone: 'amber' };
    case 'personal_open': return { text: '进行中', tone: 'teal' };
    case 'done': return { text: '已完成', tone: 'gray' };
    case 'cancelled': return { text: '已取消', tone: 'gray' };
    default: return { text: '进行中', tone: 'teal' };
  }
}
// 是否仍在等待主控审核（用于“催促”“待处理”判定，只读展示）
export function isAwaitingReview(t: Task): boolean {
  return t.main_state === 'incomplete' && (t.current_node === 'awaiting_plan_review' || t.current_node === 'awaiting_code_review');
}
export function isDone(t: Task): boolean { return t.main_state === 'completed' || t.main_state === 'cancelled'; }

export const ISSUE_STATUS_LABEL: Record<string, Label> = {
  open: { text: '未解决', tone: 'green' }, resolved: { text: '已解决', tone: 'gray' },
};
export const SEVERITY_LABEL: Record<IssueSeverity, string> = { low: '轻微', mid: '一般', high: '严重' };
export const PLAN_STATUS_LABEL: Record<string, Label> = {
  pending_review: { text: '待审核', tone: 'blue' }, changes_requested: { text: '需修改', tone: 'amber' },
  approved: { text: '已通过', tone: 'green' }, rejected: { text: '已拒绝', tone: 'red' }, cancelled: { text: '已取消', tone: 'gray' },
};
export const CODE_STATUS_LABEL: Record<string, Label> = {
  pending_review: { text: '待审核', tone: 'blue' }, changes_requested: { text: '需修改', tone: 'amber' },
  approved: { text: '已通过', tone: 'green' }, rejected: { text: '已拒绝', tone: 'red' },
  cancelled: { text: '已取消', tone: 'gray' }, personal_completed: { text: '已生效', tone: 'green' },
};
export function issueStateLabel(i: Issue): Label { return ISSUE_STATUS_LABEL[i.status] || { text: i.status, tone: 'gray' }; }
export function codeStateLabel(c: CodeVersion): Label { return CODE_STATUS_LABEL[c.status] || { text: c.status, tone: 'gray' }; }
// 手机端不暴露 no_change 英文枚举（策划 §2.4）
export function deliveryKindLabel(c: CodeVersion): string { return c.delivery_kind === 'no_change' ? '无需修改' : '已提交代码'; }
export function intakeKindLabel(k?: string): string { return k === 'plan_idea' ? '策划想法' : k === 'problem' ? '问题' : ''; }

export const NOTIFICATION_KIND_LABEL: Record<NotificationKind, string> = {
  hub_update:'中枢更新',legacy_notice:'历史通知',review_pending: '待主控审核', review_result: '审核结果', revision_required: '退回整改', task_progress: '任务进度',
  issue_progress: '问题进展', issue_resolved: '问题已解决', issue_collab: '协作动态', announcement: '公司公告', device_alert: '设备提醒', chat_message: '群消息', announcement_reply: '公告回复',
};
export const RELATION_LABEL: Record<string, string> = { pending: '关联待生效', active: '已生效', replaced: '已替代', discarded: '已解除' };
export const SCOPE_LABEL: Record<string, string> = { partial: '处理一部分', complete: '接手剩余全部' };

// 时间：后端为毫秒时间戳（number）
export function ago(ts: number | null | undefined): string {
  if (!ts) return '';
  const m = Math.max(0, Math.floor((Date.now() - Number(ts)) / 60000));
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  if (m < 1440) return `${Math.floor(m / 60)} 小时前`;
  if (m < 10080) return `${Math.floor(m / 1440)} 天前`;
  return fullDate(Number(ts));
}
export function exact(ts: number | null | undefined): string {
  if (!ts) return '';
  return fullDateTime(Number(ts));
}
export function initial(name: string): string { return (name || '').trim().slice(0, 1) || '·'; }

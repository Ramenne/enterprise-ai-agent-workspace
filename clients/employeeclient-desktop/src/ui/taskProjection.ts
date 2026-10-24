// src/ui/taskProjection.ts —— 收件箱列表投影（进行中/待处理/历史）与“需要本人动作”的判定。
// 全部由 Task/责任/节点计算得出的 UI 投影，绝不写回 Task.status（策划 §26/§40/§12 行动列表投影）。
import type { Task, Project } from '@/api/types';
import { isDone as done, isAwaitingReview as awaiting } from './format';

export interface ProjContext { isMainControl: boolean; username: string; archivedTaskIds?: ReadonlySet<string>; archivedProjectIds?: ReadonlySet<string> }
export function archivedPersonalProjectIds(projects: Project[]): Set<string> {
  return new Set(projects.filter(p => p.scope === 'personal' && p.status === 'archived').map(p => p.id));
}
function projectHidden(t: Task, ctx: ProjContext): boolean {
  return t.scope_at_creation === 'personal' && !!ctx.archivedProjectIds?.has(t.project_id);
}

export const isDone = done;
export const isAwaitingReview = awaiting;

/** 当前账号是否必须对该 Task 采取动作：
 *  - 主控：公司 Task 正等待其审核（策划/代码待审）；
 *  - 员工：派给自己且停在需要自己推进的节点（待交代码 / 策划需修改 / 代码需修改）。 */
export function actionNeeded(t: Task, ctx: ProjContext): boolean {
  if (isDone(t) || t.main_state === 'paused') return false;
  if (ctx.isMainControl && t.scope_at_creation === 'company') return isAwaitingReview(t);
  const mine = t.assignee_username === ctx.username;
  return mine && ['awaiting_code', 'awaiting_plan_revision', 'awaiting_code_revision'].includes(t.current_node);
}

/** 收件箱分类：active=进行中（未完成且当前不要求本人立即动作）；action=待处理；history=已结束。 */
export type InboxTab = 'active' | 'action' | 'history';
export function projectInbox(tasks: Task[], ctx: ProjContext, tab: InboxTab, scopeFilter: 'all' | 'company' | 'personal' = 'all'): Task[] {
  let list = tasks.filter(t => !ctx.archivedTaskIds?.has(t.id) && (scopeFilter === 'all' ? true : t.scope_at_creation === scopeFilter));
  if (tab === 'history') return list.filter(isDone);
  list = list.filter(t => !isDone(t) && !projectHidden(t, ctx));
  if (tab === 'action') return list.filter(t => actionNeeded(t, ctx));
  // 进行中：未完成、且当前不要求本人立即动作（待处理单独成组，互斥）
  return list.filter(t => !actionNeeded(t, ctx));
}
export function countAction(tasks: Task[], ctx: ProjContext): number { return tasks.filter(t => !ctx.archivedTaskIds?.has(t.id) && !projectHidden(t, ctx) && !isDone(t) && actionNeeded(t, ctx)).length; }

/** Same authoritative company action list drives both the Work badge and Work landing page. */
export function companyActionTasks(tasks: Task[], ctx: ProjContext): Task[] {
  return tasks.filter(t => t.scope_at_creation === 'company' && actionNeeded(t, ctx)).sort((a,b) => b.updated_at-a.updated_at);
}

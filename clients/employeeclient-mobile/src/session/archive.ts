// src/session/archive.ts —— 个人展示态归档（Task/Issue）：按账号保存在本机，只影响本人默认列表投影。
// 归档不是业务状态：不改 Task/Issue/IssueTask，不完成任务、不解决问题（策划 §17/§31/§378）。
// 公司 Task 收到需要本人行动的新事件时应自动退出归档（由调用方在同步后校正）。
import { ref } from 'vue';
import type { Task, Notification } from '@/api/types';
import { actionNeeded } from '@/ui/taskProjection';
const revision = ref(0);
const key = (account: string, kind: 'task' | 'issue') => `qn.archive.${kind}.${account}`;
const basisKey = (account: string) => `qn.archive-basis.${account}`;
interface Basis { taskVersion: number; noticeVersion: number }
function readBasis(a: string): Record<string, Basis> { try { return JSON.parse(localStorage.getItem(basisKey(a)) || '{}'); } catch { return {}; } }
function storedIds(account: string, kind: 'task' | 'issue'): string[] {
  const raw = localStorage.getItem(key(account, kind));
  if (!raw) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string')) throw new Error('本机归档记录无法读取');
  return value;
}

export function listArchived(account: string, kind: 'task' | 'issue'): string[] {
  void revision.value;
  if (!account) return [];
  try { return storedIds(account, kind); } catch { return []; }
}
export function setArchived(account: string, kind: 'task' | 'issue', id: string, archived: boolean, basis?: Basis): boolean {
  if (!account) return false;
  try {
    const cur = new Set(storedIds(account, kind));
    if (archived) cur.add(id); else cur.delete(id);
    if (kind === 'task') {
      const entries = readBasis(account);
      if (archived && basis) entries[id] = basis; else if (!archived) delete entries[id];
      localStorage.setItem(basisKey(account), JSON.stringify(entries));
    }
    localStorage.setItem(key(account, kind), JSON.stringify([...cur]));
    revision.value++;
    return true;
  } catch { return false; }
}
export function archiveTask(account: string, task: Task, notices: Notification[]) {
  return setArchived(account, 'task', task.id, true, { taskVersion: task.version, noticeVersion: Math.max(0, ...notices.filter(n=>n.object_id===task.id).map(n=>n.update_version)) });
}
export function reconcileTaskArchives(account: string, tasks: Task[], notices: Notification[], isMainControl: boolean) {
  const entries = readBasis(account);
  for (const id of listArchived(account, 'task')) {
    const task = tasks.find(t=>t.id===id); if (!task) continue;
    const basis = entries[id];
    if (!basis) { archiveTask(account, task, notices); continue; } // legacy local markers acquire a baseline, not a fabricated event
    const needsAction = actionNeeded(task, {username:account, isMainControl});
    const newActionNotice = notices.some(n=>n.object_type==='task' && n.object_id===id && !n.hidden_at && !n.acked_at && ['revision_required','review_pending'].includes(n.kind) && n.update_version>basis.noticeVersion);
    if (needsAction && (task.version>basis.taskVersion || newActionNotice)) setArchived(account,'task',id,false);
  }
}
export function clearArchives(account: string) {
  localStorage.removeItem(key(account,'task')); localStorage.removeItem(key(account,'issue')); localStorage.removeItem(basisKey(account)); revision.value++;
}

// src/session/drafts.ts —— 【职责3 会话层】本机草稿：按身份权限服务账号隔离，只保存在当前设备，不上传中枢、不跨设备同步。
// 草稿不是可重拉的显示缓存：版本更新、权限核验和单个个人接口拒绝均不得删除原稿。
// 提交成功 / 确认账号失效或设备解绑时才清理对应内容。
import { ref } from 'vue';
import type { Scope, IntakeKind, IssueSeverity } from '@/api/types';
import { personalDenied } from './scopeAccess';
import { clearPendingWrites } from './pendingWrites';

export interface Draft {
  id: string;
  scope: Scope | '';
  project_id: string;
  intake_kind: IntakeKind;
  title: string;
  detail: string;
  severity: IssueSeverity;
  updatedAt: number;
  submission?: { key: string; body: { title: string; detail: string; severity: IssueSeverity; scope: Scope; project_id?: string; intake_kind?: IntakeKind } };
}
const key = (account: string) => 'qn.drafts.' + account;
export const draftRevision = ref(0);

/** 读取存储原件，不套当前可见范围；任何写入都必须以它为基底，不能拿被权限遮挡的列表回写。 */
function storedDrafts(account: string): Draft[] {
  if (!account) return [];
  const raw = localStorage.getItem(key(account));
  if (!raw) return [];
  let rows: unknown;
  try { rows = JSON.parse(raw); } catch { throw new Error('本机草稿数据无法读取，已停止写入以免覆盖原稿'); }
  if (!Array.isArray(rows)) throw new Error('本机草稿格式异常，已停止写入以免覆盖原稿');
  return rows as Draft[];
}

/** 用于草稿页：读取失败应显示错误，不能伪装成「没有草稿」。 */
export function loadDrafts(account: string): Draft[] {
  void draftRevision.value;
  return storedDrafts(account).filter(d => !personalDenied(account) || d.scope !== 'personal');
}

export function listDrafts(account: string): Draft[] {
  try { return loadDrafts(account); } catch { return []; }
}
export function saveDraft(account: string, d: Draft): void {
  if (!account) throw new Error('尚未确认当前账号，草稿未保存');
  // 写本机未提交原稿不等于访问/提交私人业务数据；权限核验期间允许继续记草稿，读取仍保持遮挡。
  const all = storedDrafts(account).filter(x => x.id !== d.id);
  all.unshift({ ...d, updatedAt: Date.now() });
  localStorage.setItem(key(account), JSON.stringify(all));
  draftRevision.value++;
}
export function deleteDraft(account: string, id: string): void {
  if (!account) throw new Error('尚未确认当前账号，草稿未删除');
  const all = storedDrafts(account).filter(x => x.id !== id);
  localStorage.setItem(key(account), JSON.stringify(all));
  draftRevision.value++;
}
export function newDraftId(): string { return 'draft-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
function cleanBoth(drafts: () => void, writes: () => void): void {
  const errors: unknown[] = [];
  try { drafts(); } catch (e) { errors.push(e); }
  try { writes(); } catch (e) { errors.push(e); }
  if (errors.length) throw errors[0];
}
export function clearDrafts(account: string): void {
  cleanBoth(() => { localStorage.removeItem(key(account)); draftRevision.value++; }, () => clearPendingWrites(account));
}

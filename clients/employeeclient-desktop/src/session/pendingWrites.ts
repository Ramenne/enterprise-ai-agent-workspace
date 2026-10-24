// Local recovery intents only; not a second business ledger and never content-based deduplication.
import { newIdempotencyKey } from '@/api/client';
import { personalDenied } from './scopeAccess';
import type { Scope } from '@/api/types';
export interface PendingWrite<T> { key: string; scope: Scope; body: T }
const storageKey = (account: string) => 'qn.pending-writes.' + account;
function read(account: string): Record<string, PendingWrite<unknown>> {
  const raw = localStorage.getItem(storageKey(account));
  if (!raw) return {};
  const result = JSON.parse(raw);
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw Error('本机提交恢复记录无法读取，请先处理本机存储');
  return result;
}
export function pendingWrite<T>(account: string, slot: string, scope: Scope): PendingWrite<T> | null {
  if (!account || (scope === 'personal' && personalDenied(account))) return null;
  const value = read(account)[slot];
  if (!value) return null;
  if (value.scope !== scope || !value.key || !value.body) throw Error('提交恢复记录不匹配');
  return value as PendingWrite<T>;
}
export function beginWrite<T>(account: string, slot: string, scope: Scope, body: T, key = newIdempotencyKey('write')): PendingWrite<T> {
  if (!account || (scope === 'personal' && personalDenied(account))) throw Error('当前账号已无此范围权限');
  const old = pendingWrite<T>(account, slot, scope);
  if (old) return old;
  const intent = { key, scope, body: JSON.parse(JSON.stringify(body)) as T };
  const all = read(account); all[slot] = intent;
  // Must persist before issuing the request; storage failure is not permission to send untracked work.
  localStorage.setItem(storageKey(account), JSON.stringify(all));
  return intent;
}
export function endWrite(account: string, slot: string, key: string): void {
  const all = read(account);
  if (all[slot]?.key !== key) return;
  delete all[slot]; localStorage.setItem(storageKey(account), JSON.stringify(all));
}
/** Preserve the operation key while adding a confirmed intermediate receipt. */
export function updateWrite<T>(account: string, slot: string, key: string, body: T): void {
  const all = read(account);
  if (all[slot]?.key !== key) throw Error('提交恢复记录已变化');
  all[slot] = {...all[slot], body: JSON.parse(JSON.stringify(body))};
  localStorage.setItem(storageKey(account), JSON.stringify(all));
}
export function clearPendingWrites(account: string, scope?: Scope): void {
  if (!scope) { localStorage.removeItem(storageKey(account)); return; }
  const all = read(account);
  for (const slot of Object.keys(all)) if (all[slot].scope === scope) delete all[slot];
  localStorage.setItem(storageKey(account), JSON.stringify(all));
}

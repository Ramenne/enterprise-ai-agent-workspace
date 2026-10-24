import { shallowRef } from 'vue';
import { useDataStore } from '@/store/data';
import { useUiStore } from '@/store/ui';
import { beginWrite, pendingWrite, endWrite, type PendingWrite } from '@/session/pendingWrites';
import type { Scope } from '@/api/types';
export function usePendingWrite<T>(scope: Scope, operation: string, objectId = '') {
  const lease = useDataStore().captureLease(), slot = JSON.stringify([operation, objectId]);
  const pending = shallowRef<PendingWrite<T> | null>(null);
  let readError: unknown;
  try { pending.value = pendingWrite<T>(lease.account, slot, scope); } catch (e) { readError = e; }
  function start(body: T): PendingWrite<T> {
    if (!lease.valid()) throw Error('会话或权限已变更，请重新打开');
    if (readError) throw readError;
    return pending.value = beginWrite(lease.account, slot, scope, body);
  }
  function finish() {
    if (!lease.valid()) return;
    if (pending.value) endWrite(lease.account, slot, pending.value.key);
    pending.value = null;
  }
  async function discard() {
    if (!pending.value || !lease.valid()) return;
    const key = pending.value.key;
    const ok = await useUiStore().confirm({ title: '放弃本次提交恢复？', text: '上次操作可能已在服务端成功。放弃只清除本机恢复记录，不能撤销服务端结果。请先查看结果；之后再次提交会视为一次全新操作。', label: '确认放弃恢复' });
    if (ok && lease.valid() && pending.value?.key === key) finish();
  }
  return { pending, start, finish, discard, valid: lease.valid, account: lease.account };
}

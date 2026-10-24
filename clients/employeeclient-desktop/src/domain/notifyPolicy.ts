// src/domain/notifyPolicy.ts —— 通知同步与弹窗的纯决策策略（零运行时依赖，可被 node:test 直接执行验证）。
// 依据策划 v0.24 §零 Android 通知传输与补取方案（尤其 7/13 项）、§5.1 通知四级分类、§6.2、§7.3.1。
//
// 为什么单独成模块：isNewArrival / isCursorRestartHint / alreadyPresented / isSilentRecord / numericId 是
// 「到达判定 · 游标失效判定 · 弹窗去重 · 静默分级 · 通知 id 稳定哈希」的纯函数，原先内联在 store/data.ts 与
// platform/localNotify.ts 中；那两个模块分别依赖 pinia+@/api 与 @capacitor+@/session+localStorage，node 无法
// 直接 import 测试，导致客户端补取/去重核心决策长期只有代码审查这一间接证据。抽到本零依赖叶子模块后，
// dev/notifyPolicy.test.mjs（node:test）可直接执行验证；data.ts 与 localNotify.ts 改为 import 使用，行为完全
// 等价——instanceof 收窄、localStorage 读写、系统调度等有副作用或有环境依赖的部分仍留在原模块，本模块只含纯判定。
// 唯一 import 是 type-only 的 Notification，编译期擦除，不产生运行时依赖。
import type { Notification } from '@/api/types';

/** 弹窗去重日志条目：[notification id, 已提示的 update_version]，按插入顺序。独立于通知缓存持久化。 */
export type NotifiedLog = Array<[string, number]>;

/**
 * 判定「新到达」：只有它才可能触发系统弹窗，本人投影更新不算（策划 v0.24 §零-7、§零-13）。
 * - 缓存里原本没有这个 id → 新消息；
 * - 缓存里有、但 priority 由非 urgent 升为 urgent → 员工明确催促把主控待审提升为 urgent（§5.1 紧急催促），算合法再次到达；
 * - 其余（已读、隐藏、置顶、稍后提醒等本人投影变化）只更新列表，不弹窗。
 * 跨设备已读能走增量：服务端 schema.mjs 的 notification_update_seq 触发器在 version 变更时递增 change_seq。
 */
export function isNewArrival(before: Map<string, Notification>, n: Notification): boolean {
  const old = before.get(n.id);
  if (!old) return true;
  return old.priority !== 'urgent' && n.priority === 'urgent';
}

/**
 * 持续悬浮层可见性判定（策划 v0.24 §5.1 白名单 + 不变量#24「到期只退出悬浮层」）。
 * 是 notify.mjs publicNotification 的 persistent_float 到期子句（expires_at==null || expires_at>now）的客户端镜像：
 * 只有服务端标记 persistent_float、未隐藏、且未本地到期的通知才进悬浮层。
 * 为何必须客户端判到期：expires_at 是时间触发、服务端不改行、change_seq 不 bump，增量同步不会重发这条，
 *   缓存里的 persistent_float:true 快照会滞留到下次全量同步；不本地判到期就会违反「到期退出悬浮层」。
 * now 由调用方注入（便于单测，也便于日后接响应式 tick）；本函数不读 Date.now，保持纯函。
 */
export function isFloatingEligible(n: Notification, now: number): boolean {
  return !!n.persistent_float && !n.hidden_at && (n.expires_at == null || n.expires_at > now);
}

/**
 * 全量收敛（断联补取）：给定本地缓存与本次「完整全量分页」返回的 id 集合，算出应清除的 ghost id。
 * 规则：只清「本地可见（未隐藏）但服务端本次全量未返回」的通知——它们已被服务端删除/迁移/换库（id 不再存在）。
 * 为何保留隐藏墓碑（hidden_at 非空）：notify.mjs listFor 非 delta 分页只加 hidden_at IS NULL，故完整全量本就不返回隐藏行；
 *   隐藏行靠增量作撤销投影重发，若把未返回的隐藏墓碑也删了，日后该行再变更会被 isNewArrival（!old→true）当成新到达误弹窗。
 * 调用前提（由 data.ts 保证）：仅在一次完整全量分页走完（!delta、拿到 sync_version、无续读游标）时调用；增量返回集不完整，绝不可据此淘汰。
 * 纯函数，不触网不读盘，可被 node:test 直接验证。
 */
export function ghostIdsToEvict(cached: Notification[], seenIds: ReadonlySet<string>): string[] {
  return cached.filter(c => !c.hidden_at && !seenIds.has(c.id)).map(c => c.id);
}

/**
 * 纯字符串判定：服务端是否明确「当前游标/版本不可再用」→ 必须丢弃进度重全量同步。
 * 由 data.ts 在确认 `e instanceof ApiError` 后调用；断网/超时/401 等不在此列（保留断点后续读）。
 * 对应后端 notify.mjs listFor 的三类 fail-closed：快照变化(409)、after_version 越界、游标作用域/base 不符。
 */
export function isCursorRestartHint(code: string, hint: string): boolean {
  if (code === 'idempotency_conflict') return /snapshot_changed_restart/.test(hint);
  if (code === 'validation_failed') return /invalid_after_version|cursor_scope_mismatch|cursor_base_mismatch/.test(hint);
  return false;
}

/**
 * 弹窗去重：已提示版本 >= 当前版本 → 不再响铃；同一 id 的更高版本（催促把 priority 提升为 urgent 并
 * update_version+1）仍允许再次提示，因此去重不会抹掉合法再次催促（§零-7、§零-13、§7.3.1）。
 */
export function alreadyPresented(log: NotifiedLog, id: string, updateVersion: number): boolean {
  const hit = log.find(e => e[0] === id);
  return !!hit && hit[1] >= updateVersion;
}

/**
 * 「普通记录」静默集合（§5.1 四级分类、§6.2）：本人内容自动生效、版本登记等只进收件箱、默认静默。
 *
 * 现网事实（已逐行核准）：主线 notify.mjs 的 personal 投影函数 notifyOwner 注明「本人自动生效的普通记录默认
 * 静默（客户端据 kind/priority 处理）」，但当前没有任何调用点，personal 自动生效事件不产生 Notification；已投产
 * 的 9 种 kind（review_pending / review_result / revision_required / task_progress / issue_progress /
 * issue_resolved / issue_collab / announcement / device_alert）按策划全部属于「待处理／处理结果／紧急催促」，
 * 都应有声。因此本集合当前为空——这不是遗漏，而是现网没有需要静默的通知类型。
 *
 * 接线要求：personal 全链上线、服务端开始投影本人自动生效事件时，把实际使用的 kind 加入本集合即可，弹窗层其余
 * 逻辑不用改。未知 kind 一律按「有声」处理：宁可多提示一次，也不能把真实待办静默掉。判定只看服务端字段，
 * 不用客户端自报角色或本地推断范围（§5.5 唯一主控的移动视角、§三审批策略）。
 */
export const SILENT_RECORD_KINDS: ReadonlySet<string> = new Set<string>([]);

/** 静默判定单点：命中静默集合，且不是紧急催促（urgent 必须发声、标红、置顶）。 */
export function isSilentRecord(n: Notification): boolean {
  if (n.priority === 'urgent') return false;
  if (n.snapshot?.silent === true) return true;
  return SILENT_RECORD_KINDS.has(n.kind);
}

/**
 * Android 通知 id 必须是整数；用 FNV-1a 把服务端 notification id 稳定映射为同一整数，
 * 使同一通知重复调度时替换而非叠加（等效 iPhone Web Push 的 tag 去重）。返回值域 [1, 0x7ffffffe]。
 */
export function numericId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return ((h >>> 0) % 0x7ffffffe) + 1;
}

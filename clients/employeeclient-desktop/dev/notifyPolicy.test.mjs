// dev/notifyPolicy.test.mjs —— 客户端通知同步/弹窗去重核心决策的单元测试（node:test，零依赖）。
//
// 为什么这个测试重要：断联补取与弹窗去重是策划 v0.24 §零-7 / §零-13 / §7.3.1 的硬要求，但其决策逻辑
// （isNewArrival / isCursorRestartHint / alreadyPresented / isSilentRecord / numericId）此前内联在依赖
// pinia、@capacitor、localStorage 的模块里，node 无法直接 import，长期只有代码审查这一间接证据。抽到
// src/domain/notifyPolicy.ts（零运行时依赖叶子模块）后，本测试用 node 内置 test runner 直接执行源码逻辑，
// 逐条对照策划断言。运行：node --test dev/notifyPolicy.test.mjs（或 npm run test:policy）。
// 与 dev/probe-catchup.mjs（打真实后端验证补取契约）互补：这里测“客户端决策逻辑本身”，共同构成断联补取证据链。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isNewArrival, isCursorRestartHint, alreadyPresented, isSilentRecord, numericId, SILENT_RECORD_KINDS, isFloatingEligible, ghostIdsToEvict,
} from '../src/domain/notifyPolicy.ts';

// 构造最小 Notification 形状（只含决策函数关心的字段；node type stripping 下按鸭子类型传入）。
const N = (id, priority, extra = {}) => ({ id, priority, kind: 'announcement', update_version: 1, ...extra });

// ==================== isNewArrival：到达判定（只有新到达才可能弹窗）====================
test('isNewArrival：缓存无此 id → 新到达（弹窗）', () => {
  assert.equal(isNewArrival(new Map(), N('n1', 'normal')), true);
});

test('isNewArrival：本人投影变化（priority 不变的已读/隐藏）→ 不算到达（不弹窗）[策划§零-7]', () => {
  const before = new Map([['n1', N('n1', 'normal')]]);
  assert.equal(isNewArrival(before, N('n1', 'normal', { read_at: 123 })), false);
  assert.equal(isNewArrival(before, N('n1', 'normal', { hidden_at: 456 })), false);
});

test('isNewArrival：normal→urgent（员工明确催促提升主控待审）→ 合法再次到达 [策划§零-13/§5.1]', () => {
  const before = new Map([['n1', N('n1', 'normal')]]);
  assert.equal(isNewArrival(before, N('n1', 'urgent')), true);
});

test('isNewArrival：urgent→urgent（补取/重试/重复连接）→ 不再到达（不重复响铃）[策划§零-7]', () => {
  const before = new Map([['n1', N('n1', 'urgent')]]);
  assert.equal(isNewArrival(before, N('n1', 'urgent')), false);
});

test('isNewArrival：不同 id 独立判定，互不影响', () => {
  const before = new Map([['n1', N('n1', 'urgent')]]);
  assert.equal(isNewArrival(before, N('n2', 'normal')), true);
});

// ==================== isCursorRestartHint：游标失效判定（该丢弃进度重全量 vs 保留断点续读）====================
test('isCursorRestartHint：409 快照变化 → 丢弃进度重全量 [策划§7.3.1]', () => {
  assert.equal(isCursorRestartHint('idempotency_conflict', 'notification_snapshot_changed_restart'), true);
});

test('isCursorRestartHint：after_version 越界 → 重全量', () => {
  assert.equal(isCursorRestartHint('validation_failed', 'invalid_after_version'), true);
});

test('isCursorRestartHint：游标跨用户作用域不符 → 重全量', () => {
  assert.equal(isCursorRestartHint('validation_failed', 'cursor_scope_mismatch'), true);
});

test('isCursorRestartHint：游标 base 不符 → 重全量', () => {
  assert.equal(isCursorRestartHint('validation_failed', 'cursor_base_mismatch'), true);
});

test('isCursorRestartHint：idempotency_conflict 但非快照变化 hint → 不重全量', () => {
  assert.equal(isCursorRestartHint('idempotency_conflict', 'some_other_conflict'), false);
});

test('isCursorRestartHint：validation_failed 但无关 hint（如 limit 越界）→ 不重全量', () => {
  assert.equal(isCursorRestartHint('validation_failed', 'limit_out_of_range'), false);
});

test('isCursorRestartHint：断网/超时/上游不可达 → 不重全量（保留断点续读）[策划§零-13 中断重取不漏页]', () => {
  assert.equal(isCursorRestartHint('network', '请求超时'), false);
  assert.equal(isCursorRestartHint('upstream_unavailable', '上游不可达'), false);
});

test('isCursorRestartHint：401 未认证 → 不重全量（交会话层处理）', () => {
  assert.equal(isCursorRestartHint('unauthenticated', '设备会话失效'), false);
});

// ==================== alreadyPresented：弹窗去重（独立记录已提示版本）====================
test('alreadyPresented：空日志（首次）→ 未提示过（应响铃）', () => {
  assert.equal(alreadyPresented([], 'n1', 1), false);
});

test('alreadyPresented：已提示 v3、当前 v3 → 已提示（不重复响铃）[策划§零-7]', () => {
  assert.equal(alreadyPresented([['n1', 3]], 'n1', 3), true);
});

test('alreadyPresented：已提示 v3、当前 v2（更旧版本）→ 已提示（不响铃）', () => {
  assert.equal(alreadyPresented([['n1', 3]], 'n1', 2), true);
});

test('alreadyPresented：已提示 v3、当前 v4（催促升级 update_version+1）→ 未提示（合法再次响铃）[策划§零-13]', () => {
  assert.equal(alreadyPresented([['n1', 3]], 'n1', 4), false);
});

test('alreadyPresented：不同 id 不互相干扰', () => {
  const log = [['n1', 5]];
  assert.equal(alreadyPresented(log, 'n2', 1), false);
  assert.equal(alreadyPresented(log, 'n1', 5), true);
});

test('alreadyPresented：多条日志正确查找目标 id', () => {
  const log = [['n1', 2], ['n2', 7], ['n3', 1]];
  assert.equal(alreadyPresented(log, 'n2', 7), true);
  assert.equal(alreadyPresented(log, 'n2', 8), false);
  assert.equal(alreadyPresented(log, 'n3', 1), true);
});

// ==================== isSilentRecord：静默分级（四级分类）====================
test('isSilentRecord：urgent（任何 kind）→ 不静默（必须发声/标红/置顶）[策划§5.1]', () => {
  assert.equal(isSilentRecord(N('n1', 'urgent', { kind: 'review_pending' })), false);
});

test('isSilentRecord：现网 9 种 kind + normal → 均不静默（都应有声）[策划§5.1/§6.2]', () => {
  const liveKinds = ['review_pending', 'review_result', 'revision_required', 'task_progress',
    'issue_progress', 'issue_resolved', 'issue_collab', 'announcement', 'device_alert'];
  for (const kind of liveKinds) assert.equal(isSilentRecord(N('n1', 'normal', { kind })), false, kind + ' 应有声');
});

test('isSilentRecord：未知 kind + normal → 不静默（宁可多提示，不静默真实待办）', () => {
  assert.equal(isSilentRecord(N('n1', 'normal', { kind: 'some_future_kind' })), false);
});

test('SILENT_RECORD_KINDS：现网为空（personal 自动生效事件当前不产生 Notification）', () => {
  assert.equal(SILENT_RECORD_KINDS.size, 0);
});

// ==================== isFloatingEligible：持续悬浮层可见性（含到期退出）====================
const NOW = 1_700_000_000_000;
const F = (extra = {}) => ({ persistent_float: true, hidden_at: null, expires_at: null, ...extra });

test('isFloatingEligible：persistent_float + 未隐藏 + 无到期 → 进悬浮层', () => {
  assert.equal(isFloatingEligible(F(), NOW), true);
});

test('isFloatingEligible：已到期（expires_at <= now）→ 退出悬浮层 [不变量#24 到期只退出悬浮层]', () => {
  assert.equal(isFloatingEligible(F({ expires_at: NOW - 1 }), NOW), false);
  assert.equal(isFloatingEligible(F({ expires_at: NOW }), NOW), false, '边界：expires_at==now 已到期');
});

test('isFloatingEligible：未到期（expires_at > now）→ 仍悬浮', () => {
  assert.equal(isFloatingEligible(F({ expires_at: NOW + 1 }), NOW), true);
});

test('isFloatingEligible：已隐藏 → 退出悬浮层（隐藏优先于到期）', () => {
  assert.equal(isFloatingEligible(F({ hidden_at: NOW - 5 }), NOW), false);
});

test('isFloatingEligible：persistent_float=false（已读/已知悉/静默/非白名单）→ 不悬浮', () => {
  assert.equal(isFloatingEligible(F({ persistent_float: false }), NOW), false);
});

test('isFloatingEligible：服务端快照 persistent_float 滞留为 true 但已到期 → 客户端仍正确退出（修复到期不重发缺口）', () => {
  // 复现真实 bug：缓存快照 persistent_float=true（公告发布时），expires_at 已过；增量同步不重发。
  assert.equal(isFloatingEligible(F({ persistent_float: true, expires_at: NOW - 60_000 }), NOW), false);
});

// ==================== ghostIdsToEvict：全量收敛清除 ghost（断联补取）====================
const C = (id, extra = {}) => ({ id, hidden_at: null, ...extra });

test('ghostIdsToEvict：可见但全量未返回 → 判为 ghost 清除', () => {
  assert.deepEqual(ghostIdsToEvict([C('gone1'), C('keep1')], new Set(['keep1'])), ['gone1']);
});

test('ghostIdsToEvict：可见且全量返回 → 保留', () => {
  assert.deepEqual(ghostIdsToEvict([C('a'), C('b')], new Set(['a', 'b'])), []);
});

test('ghostIdsToEvict：隐藏墓碑即使未返回也保留（避免 isNewArrival 误弹窗）', () => {
  const cached = [C('hidden1', { hidden_at: 123 }), C('vis-gone')];
  assert.deepEqual(ghostIdsToEvict(cached, new Set()), ['vis-gone'], '只清可见 ghost，隐藏墓碑不动');
});

test('ghostIdsToEvict：空 seenIds（服务端已无任何通知）→ 清除全部可见项、保留隐藏项', () => {
  const cached = [C('v1'), C('v2'), C('h1', { hidden_at: 1 })];
  assert.deepEqual(ghostIdsToEvict(cached, new Set()).sort(), ['v1', 'v2']);
});

test('ghostIdsToEvict：空缓存 → 无可清（不报错）', () => {
  assert.deepEqual(ghostIdsToEvict([], new Set(['x'])), []);
});

// ==================== numericId：Android 通知 id 稳定整数映射 ====================
test('numericId：同一 id 多次调用稳定（重复调度替换而非叠加）', () => {
  assert.equal(numericId('notif-xyz'), numericId('notif-xyz'));
});

test('numericId：值域合法（Android 通知 id 必须为正整数，落在 [1, 0x7ffffffe]）', () => {
  for (const id of ['', 'a', 'notif-1', 'very-long-notification-id-'.repeat(10), '中文通知id']) {
    const v = numericId(id);
    assert.ok(Number.isInteger(v), 'must be integer: ' + id);
    assert.ok(v >= 1 && v <= 0x7ffffffe, 'in range: ' + id + ' → ' + v);
  }
});

test('numericId：不同 id 通常映射不同整数（500 抽样几乎无碰撞）', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(numericId('notif-' + i));
  assert.ok(seen.size >= 495, '500 个 id 至少 495 个不同整数，实际 ' + seen.size);
});

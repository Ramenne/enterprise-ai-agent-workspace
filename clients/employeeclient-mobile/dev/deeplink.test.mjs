// dev/deeplink.test.mjs —— 通知点击深链路由的单元测试（node:test，零依赖）。
//
// 为什么测这个：routeFromDeepLink / routeFromTarget / routeFromNotification 决定「点通知跳到哪一页」，是本地
// 通知与深链（含交回说明 §11.7 记录的 Android 冷启动深链已知限制正涉及此路径）的关键纯函数，此前零测试。
// deeplink.ts 只 `import type { Notification }`（编译期擦除），node 可直接执行源码逻辑。
// 运行：npm test（自动发现 dev/*.test.mjs）或 node --test dev/deeplink.test.mjs。
// 与 notifyPolicy.test.mjs 互补：那边测「补取/弹窗去重决策」，这边测「点击后路由到哪」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeFromDeepLink, routeFromTarget, routeFromNotification } from '../src/platform/deeplink.ts';

// ==================== routeFromDeepLink：解析服务端深链（只认 /api/v2/{me|control}/... 五种）====================
test('routeFromDeepLink：空链接 → null', () => {
  assert.equal(routeFromDeepLink(''), null);
});

test('routeFromDeepLink：me/tasks/:id → task 路由，review=false（me 视角且非 review_pending）', () => {
  assert.deepEqual(routeFromDeepLink('/api/v2/me/tasks/t-123'), { name: 'task', params: { id: 't-123' }, review: false });
});

test('routeFromDeepLink：control/tasks/:id → task 路由且 review=true（主控审核视角）', () => {
  assert.deepEqual(routeFromDeepLink('/api/v2/control/tasks/t-9'), { name: 'task', params: { id: 't-9' }, review: true });
});

test('routeFromDeepLink：me/tasks/:id + kind=review_pending → review=true（员工催促待主控审）', () => {
  assert.deepEqual(routeFromDeepLink('/api/v2/me/tasks/t-1', 'review_pending'), { name: 'task', params: { id: 't-1' }, review: true });
});

test('routeFromDeepLink：me/issues/:id → issue 路由（不带 review 键）', () => {
  assert.deepEqual(routeFromDeepLink('/api/v2/me/issues/i-5'), { name: 'issue', params: { id: 'i-5' } });
});

test('routeFromDeepLink：control/issues/:id → issue 路由，仍不带 review（issue 无审核态）', () => {
  assert.deepEqual(routeFromDeepLink('/api/v2/control/issues/i-7'), { name: 'issue', params: { id: 'i-7' } });
});

test('routeFromDeepLink：me/announcements → announcements 路由', () => {
  assert.deepEqual(routeFromDeepLink('/api/v2/me/announcements'), { name: 'announcements', params: {} });
});

test('routeFromDeepLink：me/devices → profile 路由', () => {
  assert.deepEqual(routeFromDeepLink('/api/v2/me/devices'), { name: 'profile', params: {} });
});

test('routeFromDeepLink：task id 含 query/hash 只取路径段（[^/?#]+ 在 ? 前截断）', () => {
  assert.deepEqual(routeFromDeepLink('/api/v2/me/tasks/t-1?x=2#y'), { name: 'task', params: { id: 't-1' }, review: false });
});

test('routeFromDeepLink：未识别的 /api/v2/me/xxx → null（不自行发明路由目标）', () => {
  assert.equal(routeFromDeepLink('/api/v2/me/unknown/1'), null);
});

test('routeFromDeepLink：非服务端深链格式（无 /api/v2/ 路径、外部 URL）→ null', () => {
  assert.equal(routeFromDeepLink('/inbox'), null);
  assert.equal(routeFromDeepLink('random-string'), null);
  assert.equal(routeFromDeepLink('https://example.com/foo'), null);
});

// ==================== routeFromTarget：由最小服务端事实推导（object_type/object_id 优先，回退 deep_link）====================
test('routeFromTarget：object_type=task + object_id → task 路由，review=false', () => {
  assert.deepEqual(routeFromTarget({ object_type: 'task', object_id: 't-1' }), { name: 'task', params: { id: 't-1' }, review: false });
});

test('routeFromTarget：task + kind=review_pending → review=true', () => {
  assert.deepEqual(routeFromTarget({ object_type: 'task', object_id: 't-1', kind: 'review_pending' }), { name: 'task', params: { id: 't-1' }, review: true });
});

test('routeFromTarget：object_type=issue → issue 路由', () => {
  assert.deepEqual(routeFromTarget({ object_type: 'issue', object_id: 'i-1' }), { name: 'issue', params: { id: 'i-1' } });
});

test('routeFromTarget：object_type=announcement → announcements 路由带公告id，打开不等于已读', () => {
  assert.deepEqual(routeFromTarget({ object_type: 'announcement', object_id: 'a-1' }), { name: 'announcements', params: { id: 'a-1' } });
});

test('routeFromTarget：object_type=device → profile 路由', () => {
  assert.deepEqual(routeFromTarget({ object_type: 'device', object_id: 'd-1' }), { name: 'profile', params: {} });
});

test('routeFromTarget：未知 object_type + 无 deep_link → null（default:break 后回退空链接）', () => {
  assert.equal(routeFromTarget({ object_type: 'unknown_kind', object_id: 'x-1' }), null);
});

test('routeFromTarget：object_id 优先于 deep_link（稳定字段先判，不被 deep_link 覆盖）', () => {
  // object_type=task 命中即返回，忽略与之矛盾的 deep_link（issues）
  assert.deepEqual(
    routeFromTarget({ object_type: 'task', object_id: 't-1', deep_link: '/api/v2/me/issues/i-9' }),
    { name: 'task', params: { id: 't-1' }, review: false },
  );
});

test('routeFromTarget：无 object_id 时回退解析 deep_link', () => {
  assert.deepEqual(routeFromTarget({ deep_link: '/api/v2/me/tasks/t-5' }), { name: 'task', params: { id: 't-5' }, review: false });
});

test('routeFromTarget：空对象 → null', () => {
  assert.equal(routeFromTarget({}), null);
});

// ==================== routeFromNotification：完整通知对象（等价 routeFromTarget）====================
test('routeFromNotification：等价 routeFromTarget（委托同一事实推导）', () => {
  const n = { id: 'n-1', object_type: 'issue', object_id: 'i-3', kind: 'issue_progress', deep_link: '/api/v2/me/issues/i-3' };
  assert.deepEqual(routeFromNotification(n), routeFromTarget(n));
  assert.deepEqual(routeFromNotification(n), { name: 'issue', params: { id: 'i-3' } });
});

test('routeFromNotification：公告通知（object_type=announcement）→ announcements，且不含 review 键', () => {
  const r = routeFromNotification({ id: 'n-2', object_type: 'announcement', object_id: 'a-9', kind: 'announcement' });
  assert.deepEqual(r, { name: 'announcements', params: { id: 'a-9' } });
  assert.equal('review' in r, false);
});

// New communication notifications share existing native/SW notification ownership.
test('群消息和公告回复定位原对象', () => {
  assert.deepEqual(routeFromTarget({kind:'chat_message', object_type:'chat_message',object_id:'chat-1'}), {name:'chat',params:{},query:{message:'chat-1'}});
  assert.deepEqual(routeFromDeepLink('/api/v2/company/chat/messages/chat-1'), {name:'chat',params:{},query:{message:'chat-1'}});
  assert.deepEqual(routeFromDeepLink('/api/v2/me/announcements/ann-1'), {name:'announcements',params:{id:'ann-1'}});
  assert.deepEqual(routeFromTarget({kind:'announcement_reply',object_type:'announcement',object_id:'ann-1'}), {name:'announcements',params:{id:'ann-1'}});
});

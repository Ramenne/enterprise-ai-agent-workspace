// dev/probe-catchup.mjs —— 「断联补取」增量游标后端契约的运行时集成探针。
//
// 为什么需要它：liveLink.ts（连接状态机）+ store.ts（接线）+ data.ts（游标增量/分页续读/去重/持久化）
//   已实现「断联→重连→按 after_version 增量补取」，但这条链此前只有代码审查证据，缺运行时证据。
//   本探针用真实 HTTP 打本地 V8（notify.mjs listFor），逐条复现 data.ts 的调用口径，证明后端增量契约：
//     A. 全量排空分页 → 末页给出非 null sync_version（作为增量基线 V0）
//     B. after_version=V0 无新件时增量读 → 0 条、sync_version 不变（幂等，不产生幻影消息）
//     C. 主控发新公告 → after_version=V0 增量读只回该新件（change_seq>V0）、sync_version 前进（核心补取）
//     D. after_version=V1 再读 → 0 条（不重复投递；客户端按 id 去重并推进版本）
//     E. limit=1 多页补取 → has_more/next_cursor 续读、sync_version 只在末页非 null、各件 change_seq 严格递增且 id 唯一
//     F. 跨用户复用 A 的游标 → cursor_scope_mismatch（fail closed，不泄露/串号）
//     G. after_version 越界(>current) → invalid_after_version
//     H. base 与游标不符 → cursor_base_mismatch
//   鉴权用身份权限服务 Bearer：设备会话/qn1 链路由 smoke.mjs + probe-token-renewal.mjs 覆盖，本探针隔离「补取契约」本身，
//   并避开单账号设备数上限导致的偶发失败。补取契约与鉴权模式无关（后端同一 listFor(username)）。
//
// 先运行 `npm run dev:backend`。用法：node dev/probe-catchup.mjs
import crypto from 'node:crypto';

const V8 = process.env.V8_BASE || 'http://127.0.0.1:8934';
const HUFU = process.env.QN_DEV_HUFU_BASE || 'http://127.0.0.1:8933';
const PW = process.env.QN_DEV_PASSWORD || 'dev-local-only';
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  PASS ' + n); } else { fail++; console.error('  FAIL ' + n + ' ' + (extra || '')); } };

async function login(u) {
  const r = await fetch(HUFU + '/hufu/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: PW }) });
  const j = await r.json();
  if (!r.ok) throw new Error('身份权限服务登录失败 ' + u + ': ' + JSON.stringify(j));
  return j;
}
async function api(token, method, p, body) {
  const h = { Authorization: 'Bearer ' + token };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(V8 + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = {}; try { j = await r.json(); } catch { /* 空体 */ }
  return { status: r.status, json: j, raw: JSON.stringify(j) };
}
const idem = k => 'catchup-' + k + '-' + crypto.randomBytes(4).toString('hex');

/** 全量排空分页（复现 data.ts 非 delta 分支）：返回 {items, syncVersion, pages}。 */
async function drainFull(token) {
  let cursor = '', sv = null, pages = 0; const items = [];
  for (;;) {
    if (++pages > 50) throw new Error('full page guard exceeded');
    const q = '?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    const r = await api(token, 'GET', '/api/v2/me/notifications' + q);
    if (r.status !== 200) throw new Error('full read HTTP ' + r.status + ' ' + r.raw.slice(0, 140));
    const p = r.json; items.push(...(p.notifications || [])); sv = p.sync_version; cursor = p.next_cursor || '';
    if (!p.has_more || !cursor) break;
  }
  return { items, syncVersion: sv, pages };
}
/** 增量排空分页（复现 data.ts delta 分支）：after_version 固定，limit 可调以逼出多页。返回 {items, pages, syncVersion, sawHasMore, midCursors}。 */
async function drainDelta(token, afterVersion, limit = 200) {
  let cursor = '', sv = null, pages = 0, sawHasMore = false; const items = [], midCursors = [];
  for (;;) {
    if (++pages > 50) throw new Error('delta page guard exceeded');
    const q = '?after_version=' + afterVersion + '&limit=' + limit + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    const r = await api(token, 'GET', '/api/v2/me/notifications' + q);
    if (r.status !== 200) throw new Error('delta read HTTP ' + r.status + ' ' + r.raw.slice(0, 140));
    const p = r.json; items.push(...(p.notifications || []));
    if (p.has_more) { sawHasMore = true; midCursors.push(p.next_cursor); }
    sv = p.sync_version; cursor = p.next_cursor || '';
    if (!p.has_more || !cursor) break;
  }
  return { items, pages, syncVersion: sv, sawHasMore, midCursors };
}
const seqs = arr => arr.map(n => n.change_seq);
const uniq = arr => new Set(arr).size === arr.length;

const A = await login('qn_dev_a');
const M = await login('qn_dev_m');
console.log('本地 V8=' + V8 + '  身份权限服务=' + HUFU + '  员工=qn_dev_a 主控=qn_dev_m\n');

// ---------- A. 全量基线 ----------
console.log('[A] 全量排空 → 建立增量基线 V0');
const base = await drainFull(A.token);
const V0 = base.syncVersion;
ok('全量末页给出非 null sync_version（V0=' + V0 + '）', Number.isInteger(V0) && V0 >= 0, 'sync_version=' + JSON.stringify(V0));

// ---------- B. 无新件时增量幂等 ----------
console.log('\n[B] after_version=V0 且无新件 → 增量读应为空、版本不变（幂等，无幻影消息）');
const idle = await drainDelta(A.token, V0);
ok('无新件时增量读回 0 条', idle.items.length === 0, '实得 ' + idle.items.length + ' 条');
ok('无新件时 sync_version 仍为 V0', idle.syncVersion === V0, 'got ' + idle.syncVersion);

// ---------- C. 新件到达 → 增量补取（核心） ----------
console.log('\n[C] 主控发新公告 → after_version=V0 增量读只回该新件（核心补取）');
const ann1 = await api(M.token, 'POST', '/api/v2/control/announcements', { title: '补取探针公告1', body: '断联补取运行时证据 C', priority: 'normal', recipient_usernames: ['qn_dev_a'], idempotency_key: idem('c') });
ok('主控发布公告1（201，收件人 1）', ann1.status === 201 && ann1.json.recipient_count === 1, 'HTTP ' + ann1.status + ' ' + ann1.raw.slice(0, 120));
const c1 = await drainDelta(A.token, V0);
ok('增量读恰好回 1 条新件（不重发历史）', c1.items.length === 1, '实得 ' + c1.items.length + ' 条：' + JSON.stringify(c1.items.map(n => n.title || n.kind)));
const V1 = c1.syncVersion;
ok('新件 change_seq > V0', c1.items.length === 1 && c1.items[0].change_seq > V0, 'change_seq=' + seqs(c1.items) + ' V0=' + V0);
ok('sync_version 前进到 V1(>V0)=' + V1, Number.isInteger(V1) && V1 > V0, 'V1=' + V1);

// ---------- D. 再读不重复投递 ----------
console.log('\n[D] after_version=V1 再读 → 0 条（客户端按 id 去重、推进版本后不再收旧件）');
const c2 = await drainDelta(A.token, V1);
ok('推进版本后再读回 0 条（无重复投递）', c2.items.length === 0, '实得 ' + c2.items.length + ' 条');

// ---------- E. limit=1 多页补取 ----------
console.log('\n[E] 再发 3 条 → limit=1 多页增量补取（next_cursor 续读、sync_version 只在末页）');
for (const t of ['补取探针公告2', '补取探针公告3', '补取探针公告4']) {
  const r = await api(M.token, 'POST', '/api/v2/control/announcements', { title: t, body: '断联补取分页证据 E', priority: 'normal', recipient_usernames: ['qn_dev_a'], idempotency_key: idem('e') });
  if (r.status !== 201) { ok('发布公告 ' + t, false, 'HTTP ' + r.status + ' ' + r.raw.slice(0, 120)); }
}
// 单页读：limit=1 应 has_more=true、sync_version=null、给出 next_cursor
const oneQ = '?after_version=' + V1 + '&limit=1';
const pg1 = await api(A.token, 'GET', '/api/v2/me/notifications' + oneQ);
ok('limit=1 首页 has_more=true 且有 next_cursor', pg1.status === 200 && pg1.json.has_more === true && !!pg1.json.next_cursor, 'HTTP ' + pg1.status + ' ' + JSON.stringify({ has_more: pg1.json.has_more, nc: !!pg1.json.next_cursor }));
ok('limit=1 非末页 sync_version=null（只在末页给）', pg1.json.sync_version === null, 'sync_version=' + JSON.stringify(pg1.json.sync_version));
// 排空多页
const multi = await drainDelta(A.token, V1, 1);
const V4 = multi.syncVersion;
ok('limit=1 多页共补回 3 条新件', multi.items.length === 3, '实得 ' + multi.items.length + ' 条');
ok('多页确实经历 has_more 分页（页数=' + multi.pages + '）', multi.sawHasMore && multi.pages >= 3, 'pages=' + multi.pages + ' sawHasMore=' + multi.sawHasMore);
ok('补回各件 change_seq 严格递增（ASC 排序）', JSON.stringify(seqs(multi.items)) === JSON.stringify([...seqs(multi.items)].sort((x, y) => x - y)) && uniq(seqs(multi.items)), 'seqs=' + seqs(multi.items));
ok('补回各件 id 唯一（去重基础）', uniq(multi.items.map(n => n.id)), 'ids=' + multi.items.map(n => n.id));
ok('多页末页给出非 null sync_version（V4>V1）=' + V4, Number.isInteger(V4) && V4 > V1, 'V4=' + V4);
const afterV4 = await drainDelta(A.token, V4);
ok('补取到 V4 后再读 0 条（分页链走完不漏不重）', afterV4.items.length === 0, '实得 ' + afterV4.items.length + ' 条');

// ---------- F. 跨用户游标 scope 校验 ----------
console.log('\n[F] 跨用户复用 A 的分页游标 → cursor_scope_mismatch（fail closed，不串号）');
const aCursor = multi.midCursors[0];
ok('已取得 A 的中途分页游标', !!aCursor, 'midCursors=' + multi.midCursors.length);
if (aCursor) {
  const cross = await api(M.token, 'GET', '/api/v2/me/notifications?after_version=0&cursor=' + encodeURIComponent(aCursor));
  ok('主控 M 用员工 A 的游标被拒（4xx + cursor_scope_mismatch）', cross.status >= 400 && cross.status < 500 && cross.raw.includes('cursor_scope_mismatch'), 'HTTP ' + cross.status + ' ' + cross.raw.slice(0, 140));
}

// ---------- G. after_version 越界 ----------
console.log('\n[G] after_version 越界(>current) → invalid_after_version');
const oor = await api(A.token, 'GET', '/api/v2/me/notifications?after_version=' + (V4 + 1000000));
ok('越界 after_version 被拒（4xx + invalid_after_version）', oor.status >= 400 && oor.status < 500 && oor.raw.includes('invalid_after_version'), 'HTTP ' + oor.status + ' ' + oor.raw.slice(0, 140));

// ---------- H. 游标 base 不符 ----------
console.log('\n[H] after_version 与游标 base 不符 → cursor_base_mismatch');
if (aCursor) {
  // aCursor 的 base=V1；故意用 after_version=V4 搭配它 → base 不符
  const baseMis = await api(A.token, 'GET', '/api/v2/me/notifications?after_version=' + V4 + '&cursor=' + encodeURIComponent(aCursor));
  ok('base 不符被拒（4xx + cursor_base_mismatch）', baseMis.status >= 400 && baseMis.status < 500 && baseMis.raw.includes('cursor_base_mismatch'), 'HTTP ' + baseMis.status + ' ' + baseMis.raw.slice(0, 140));
}

console.log('\n断联补取契约探针：通过 ' + pass + '，失败 ' + fail);
process.exit(fail ? 1 : 0);

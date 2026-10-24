// dev/probe-android-no-vendor-token.mjs —— Android 厂商推送整体删除后的定向回归探针。
//
// 为什么需要它：员工客户端 Android 首期已彻底删除第三方／厂商推送（策划 v0.24 §零-1），客户端不再产生任何
// 第三方 device_token。删除后"Android 不上传订阅也能正常绑定并收消息"这条结论只写在注释里是不够的，
// 必须能在真实共享服务端上跑出来。本脚本就是那条结论的可执行证据，也是将来 V8 合并后重跑的回归入口。
//
// 覆盖四件事：
//   A. Android 设备登记**完全不带 subscription** → 必须成功，并能换 qn1 设备会话、用 qn1 读收件箱与 bootstrap；
//   B. iPhone PWA Web Push 订阅链路完整保留（带 subscription 的 ios_web_push 登记必须成功）；
//   C. 反向验证：服务端对非法 android device_token 仍然 fail closed（说明校验未被顺手删掉，只是客户端不再送）；
//   D. 两台设备都在 GET /api/v2/me/devices 里，且平台字段正确（多设备状态同步的最小证据）；
//   E. 互斥单点的运行时硬证据：主控发公告后，Android 设备（subscription_json 为空）**不产生任何投递行**，
//      iPhone 设备正常进 outbox，且全库不存在 provider='android_push' 的行。
//      这一条才是“删了厂商推送也不会双响、也不会把本地展示伪记为供应商 sent”的真实保证。
//
// 先运行 `npm run dev:backend`。用法：node dev/probe-android-no-vendor-token.mjs
// 口令只从环境变量读取，不在本文件写死真值（QN_DEV_PASSWORD 由 run-backend 注入）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const V8 = process.env.V8_BASE || 'http://127.0.0.1:8934';
const HUFU = process.env.QN_DEV_HUFU_BASE || 'http://127.0.0.1:8933';

/** 本地替身口令：优先环境变量，其次 run-backend 写在临时目录的 env.json（不在工作区内）。 */
function devPassword() {
  if (process.env.QN_DEV_PASSWORD) return process.env.QN_DEV_PASSWORD;
  try {
    const p = path.join(os.tmpdir(), 'employeeclient-dev-backend', 'env.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (j.password) return String(j.password);
  } catch { /* 未启动后端时忽略，下面统一报错 */ }
  return '';
}
const PW = devPassword();
if (!PW) { console.error('缺少本地替身口令：先运行 npm run dev:backend，或设置 QN_DEV_PASSWORD'); process.exit(2); }

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  PASS ' + n); } else { fail++; console.error('  FAIL ' + n + (extra ? ' ' + extra : '')); } };
const is2xx = s => s >= 200 && s < 300;

async function login(username) {
  const r = await fetch(HUFU + '/hufu/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PW }) });
  const j = await r.json();
  if (!r.ok) throw new Error('身份权限服务替身登录失败 ' + username + ': ' + JSON.stringify(j));
  return j;   // { token, refresh_token, username, nickname, dept, role }
}
async function api(token, method, p, body, headers) {
  const h = { Authorization: 'Bearer ' + token, ...(headers || {}) };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(V8 + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = {}; try { j = await r.json(); } catch { /* 空体 */ }
  return { status: r.status, json: j };
}
const idem = k => 'probe-' + k + '-' + crypto.randomBytes(4).toString('hex');
/** 写操作同时给 header 与 body 两个位置的幂等键，两边必须同值（客户端 client.ts 用 Idempotency-Key header）。 */
const wHeaders = k => ({ 'Idempotency-Key': k });
const brief = o => (o === undefined ? '(无)' : JSON.stringify(o).slice(0, 240));

const u = await login('qn_dev_a');
// 设备 id 固定而不随机：服务端有“单账号有效设备上限 5 台”（notify.mjs MAX_ACTIVE_DEVICES_PER_ACCOUNT），
// 每轮新建随机 id 会很快撞上限并使后续断言全部变成空真。固定 id + 开头显式解绑 → 本探针可重复运行。
const androidInst = 'probe-android-fixed';
const iosInst = 'probe-ios-fixed';
const badInst = 'probe-bad-fixed';

console.log('\n[0] 清场：显式解绑上一轮遗留的 probe-* 设备（不静默踢旧设备，走服务端真实路由）');
// 这一步同时验证 endpoints.ts 保留的 me.unbindDevice 路由真实可用：
// 手机 UI 故意不调用它（策划 v0.24：设备解除由主控在电脑端处理），但电脑端 Agent 与设备管理切片会用。
const pre = await api(u.token, 'GET', '/api/v2/me/devices');
const staleProbes = (pre.json?.devices || []).map(d => String(d.installation_id)).filter(x => x.startsWith('probe-'));
let unbound = 0;
for (const inst of staleProbes) {
  const k = idem('unbind');
  const r = await api(u.token, 'DELETE', `/api/v2/me/devices/${inst}`, undefined, wHeaders(k));
  if (is2xx(r.status)) unbound++; else console.error('     解绑 ' + inst + ' 失败 HTTP ' + r.status + ' ' + brief(r.json));
}
ok(`DELETE /api/v2/me/devices/:id 可用（遗留 ${staleProbes.length} 台，已解绑 ${unbound} 台）`, unbound === staleProbes.length, JSON.stringify(staleProbes));

console.log('\n[A] Android：不送 subscription（客户端已无任何第三方 device_token 来源）');
const kAnd = idem('and');
const reg = await api(u.token, 'PUT', `/api/v2/me/devices/${androidInst}/push-subscription`, { platform: 'android_native', idempotency_key: kAnd }, wHeaders(kAnd));
ok(`登记 android_native 无 subscription（HTTP ${reg.status}）`, is2xx(reg.status), brief(reg.json));
console.log('     回执 ' + brief(reg.json));

const kSess = idem('sess');
const sess = await api(u.token, 'POST', `/api/v2/me/devices/${androidInst}/session`, { refresh_token: u.refresh_token }, wHeaders(kSess));
ok(`换取 qn1 设备会话（HTTP ${sess.status}）`, is2xx(sess.status), brief(sess.json));
const qn1 = sess.json?.device_token || sess.json?.access_token || sess.json?.token;
ok('拿到设备会话令牌', typeof qn1 === 'string' && qn1.length > 10, brief(sess.json));
ok('设备会话令牌是 qn1 前缀', typeof qn1 === 'string' && qn1.startsWith('qn1.'), typeof qn1 === 'string' ? qn1.slice(0, 8) + '…' : String(qn1));

if (typeof qn1 === 'string' && qn1) {
  const nb = await api(qn1, 'GET', '/api/v2/me/notifications?limit=5');
  ok(`用 qn1 读收件箱（HTTP ${nb.status}）`, nb.status === 200, brief(nb.json));
  ok('收件箱返回 unread_count', typeof nb.json?.unread_count === 'number', JSON.stringify(Object.keys(nb.json || {})));
  const b2 = await api(qn1, 'GET', '/api/v2/me/bootstrap');
  ok(`用 qn1 读 bootstrap（HTTP ${b2.status}）`, b2.status === 200, String(b2.status));
  const denied = await api(qn1, 'GET', '/api/v2/control/plans');
  ok('qn1 设备会话仍被限制在账号范围（读主控队列非 200，实际 ' + denied.status + '）', !is2xx(denied.status), brief(denied.json));
}

console.log('\n[B] iPhone PWA Web Push：订阅字段与共用投递逻辑必须完整保留');
// 订阅形状按服务端 notify-security.mjs 的 validateSubscription 要求造：
//   endpoint 必须在供应商白名单（web.push.apple.com 等）；p256dh 是 65 字节未压缩 P-256 公钥（首字节 0x04）且能过 ECDH.convertKey；auth 是 16 字节。
// 因此这里生成真实椭圆曲线密钥对，取 SPKI 末尾 65 字节，而不是用随机字节冒充。
const spki = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'der' });
const sub = {
  endpoint: 'https://web.push.apple.com/probe-' + crypto.randomBytes(4).toString('hex'),
  keys: { p256dh: spki.subarray(spki.length - 65).toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') },
};
// 平台枚举以服务端为准：ios_web_push / android_native（客户端 src/api/types.ts 的 DevicePlatform 同源）。
const kIos = idem('ios');
const regIos = await api(u.token, 'PUT', `/api/v2/me/devices/${iosInst}/push-subscription`, { platform: 'ios_web_push', subscription: sub, idempotency_key: kIos }, wHeaders(kIos));
ok(`登记 ios_web_push + Web Push 订阅（HTTP ${regIos.status}）`, is2xx(regIos.status), brief(regIos.json));

console.log('\n[C] 服务端校验未被顺手删掉：非法 android device_token 仍须 fail closed');
const kBad = idem('bad');
const regBad = await api(u.token, 'PUT', `/api/v2/me/devices/${badInst}/push-subscription`, { platform: 'android_native', subscription: { device_token: '!!bad!!' }, idempotency_key: kBad }, wHeaders(kBad));
ok(`非法 device_token 被拒（HTTP ${regBad.status}）`, !is2xx(regBad.status), brief(regBad.json));

console.log('\n[D] 多设备状态同步：两台设备都在账号设备列表里');
const devs = await api(u.token, 'GET', '/api/v2/me/devices');
const list = devs.json?.devices || [];
ok(`GET /api/v2/me/devices（HTTP ${devs.status}）`, devs.status === 200, String(devs.status));
const aDev = list.find(d => d.installation_id === androidInst);
const iDev = list.find(d => d.installation_id === iosInst);
ok('Android 设备已登记', !!aDev, JSON.stringify(list.map(d => d.installation_id)));
ok('Android 设备 platform=android_native', aDev?.platform === 'android_native', brief(aDev));
ok('iPhone 设备 platform=ios_web_push', iDev?.platform === 'ios_web_push', brief(iDev));
ok('非法登记没有产生第三台设备', !list.some(d => d.installation_id === badInst), JSON.stringify(list.map(d => d.installation_id)));

console.log(`\n[E] 互斥单点：Android 无订阅 → 不进投递队列；iPhone 有订阅 → 正常进 outbox`);
// 直连本地临时库只读查证。服务端没有“按通知查设备投递回执”的账号接口（这也是客户端不做
// deviceDelivery 演示屏的原因），因此这一步只能在本地联调环境做；库不可读时如实跳过，不算失败。
function openDevDb() {
  const p = process.env.QN_DEV_DB || path.join(os.tmpdir(), 'employeeclient-dev-backend', 'v8-v2.db');
  if (!fs.existsSync(p)) return null;
  try { return { db: new DatabaseSync(p, { readOnly: true }), p }; } catch { return null; }
}
const m = await login('qn_dev_m');
const kAnn = idem('ann');
const ann = await api(m.token, 'POST', '/api/v2/control/announcements', { body: '探针公告：验证删掉厂商推送后投递队列的平台分布。', recipient_usernames: ['qn_dev_a'], idempotency_key: kAnn }, wHeaders(kAnn));
ok(`主控发布公告给 qn_dev_a（HTTP ${ann.status}）`, is2xx(ann.status), brief(ann.json));
await new Promise(r => setTimeout(r, 600));   // 业务事务同事务写 queued delivery，稍等只为避开 WAL 可见性时机

const opened = openDevDb();
if (!opened) {
  console.log('  SKIP 本地临时库不可读（未设置 QN_DEV_DB 且默认路径不存在），跳过 E 段直连查证');
} else {
  const { db, p } = opened;
  console.log('     库 ' + p);
  const aRow = db.prepare('SELECT platform, length(subscription_json) AS sub_len, status FROM device_bindings WHERE installation_id = ?').get(androidInst);
  const iRow = db.prepare('SELECT platform, length(subscription_json) AS sub_len, status FROM device_bindings WHERE installation_id = ?').get(iosInst);
  ok('Android 绑定 active 且 subscription_json 为空（没有任何第三方 Token 入库）', aRow?.status === 'active' && aRow?.sub_len === 0, brief(aRow));
  ok('iPhone 绑定 active 且 subscription_json 非空（Web Push 订阅完整保留）', iRow?.status === 'active' && iRow?.sub_len > 0, brief(iRow));

  const nRow = db.prepare("SELECT id FROM notifications WHERE recipient_username = 'qn_dev_a' ORDER BY change_seq DESC LIMIT 1").get();
  ok('公告已落为 qn_dev_a 的 Notification', !!nRow?.id, brief(nRow));
  if (nRow?.id) {
    const rows = db.prepare('SELECT device_binding_id, provider, state FROM push_deliveries WHERE notification_id = ?').all(nRow.id);
    ok('该通知没有为 Android 设备排投递（不双响、不调厂商接口）', !rows.some(r => r.device_binding_id === androidInst), brief(rows));
    ok('该通知已为 iPhone 设备排投递（共用投递逻辑未被误删）', rows.some(r => r.device_binding_id === iosInst), brief(rows));
    ok('该通知没有 android_push provider 行', !rows.some(r => r.provider === 'android_push'), brief(rows));
  }
  const anyAndroid = db.prepare("SELECT count(*) AS n FROM push_deliveries WHERE provider = 'android_push'").get();
  ok('全库零条 android_push 投递行', anyAndroid?.n === 0, brief(anyAndroid));
  const androidDeliv = db.prepare("SELECT count(*) AS n FROM push_deliveries d JOIN device_bindings b ON b.installation_id = d.device_binding_id WHERE b.platform = 'android_native'").get();
  ok('全库零条 android_native 设备投递行', androidDeliv?.n === 0, brief(androidDeliv));
  db.close();
}

console.log(`\n结果 PASS ${pass} / FAIL ${fail}`);
console.log('说明：本探针只证明接口与身份链路，不证明真机弹出通知；实机验收按策划 v0.24 §零-11 三种情况区分。');
process.exit(fail ? 1 : 0);

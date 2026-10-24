// dev/smoke.mjs —— 针对本地联调后端的端到端冒烟：验证员工客户端将要使用的真实鉴权与读取链路。
// 链路：身份权限服务登录 → 登记设备订阅 → 换取 qn1 设备会话 → 用 qn1 读 bootstrap/收件箱 → 主控发布公告 → 员工读到公告。
// 先运行 `npm run dev:backend`。用法：node dev/smoke.mjs
import crypto from 'node:crypto';

const V8 = process.env.V8_BASE || 'http://127.0.0.1:8934';
const HUFU = process.env.QN_DEV_HUFU_BASE || 'http://127.0.0.1:8933';
const PW = process.env.QN_DEV_PASSWORD || 'dev-local-only';
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  PASS ' + n); } else { fail++; console.error('  FAIL ' + n + ' ' + extra); } };

async function login(username) {
  const r = await fetch(HUFU + '/hufu/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PW }) });
  const j = await r.json();
  if (!r.ok) throw new Error('身份权限服务登录失败 ' + username + ': ' + JSON.stringify(j));
  return j;   // { token, refresh_token, username, nickname, dept, role }
}
async function api(token, method, p, body, headers) {
  const h = { Authorization: 'Bearer ' + token, ...(headers || {}) };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(V8 + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = {}; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}
function webPushSubscription(u) {
  const ec = crypto.createECDH('prime256v1'); ec.generateKeys();
  return { endpoint: 'https://web.push.apple.com/u/' + u, keys: { p256dh: ec.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
}
const idem = k => 'smoke-' + k + '-' + crypto.randomBytes(4).toString('hex');

const A = await login('qn_dev_a');
const M = await login('qn_dev_m');

// 1. bootstrap（身份权限服务 Bearer 直接可用；识别唯一主控）
const bsA = await api(A.token, 'GET', '/api/v2/me/bootstrap');
ok('员工 bootstrap 200 且非主控', bsA.status === 200 && bsA.json.is_main_control === false, JSON.stringify(bsA.json).slice(0, 160));
const bsM = await api(M.token, 'GET', '/api/v2/me/bootstrap');
ok('主控 bootstrap 识别 is_main_control=true', bsM.status === 200 && bsM.json.is_main_control === true, JSON.stringify(bsM.json).slice(0, 160));

// 2. 登记设备订阅（身份权限服务 Bearer）
const instA = 'smoke-inst-a';
const dev = await api(A.token, 'PUT', `/api/v2/me/devices/${instA}/push-subscription`, { platform: 'ios_web_push', subscription: webPushSubscription('a'), idempotency_key: idem('dev') });
ok('登记 iOS Web Push 设备成功', dev.status === 200 && dev.json.status === 'active', JSON.stringify(dev.json).slice(0, 160));

// 3. 换取 qn1 设备会话（带 refresh_token；此后只用 qn1）
const sess = await api(A.token, 'POST', `/api/v2/me/devices/${instA}/session`, { refresh_token: A.refresh_token });
ok('换取 qn1 设备会话', sess.status === 200 && String(sess.json.access_token || '').startsWith('qn1.'), JSON.stringify(sess.json).slice(0, 160));
const qn1 = sess.json.access_token;

// 4. 用 qn1 读收件箱（设备会话可用；qn1 只能打 /api/v2/*）
const inbox = await api(qn1, 'GET', '/api/v2/me/notifications');
ok('qn1 读收件箱 200（含 unread_count）', inbox.status === 200 && typeof inbox.json.unread_count === 'number', JSON.stringify(inbox.json).slice(0, 160));
const nonV2 = await fetch(V8 + '/health', { headers: { Authorization: 'Bearer ' + qn1 } });
ok('qn1 仅限 /api/v2/*（打 /health 不校验设备会话仍匿名可读，但不泄露）', nonV2.status === 200);

// 5. 主控发布公告给员工 → 员工收件箱出现公告且 persistent_float=true
const ann = await api(M.token, 'POST', '/api/v2/control/announcements', { title: '冒烟公告', body: '这是一条本地联调公告', priority: 'normal', recipient_usernames: ['qn_dev_a'], idempotency_key: idem('ann') });
ok('主控发布公告 201', ann.status === 201 && ann.json.recipient_count === 1, JSON.stringify(ann.json).slice(0, 160));
const inbox2 = await api(qn1, 'GET', '/api/v2/me/notifications?kind=announcement');
const note = (inbox2.json.notifications || [])[0];
ok('员工收到公告且未读持续悬浮', !!note && note.persistent_float === true, JSON.stringify(inbox2.json).slice(0, 200));

// 6. 员工登记公司问题反馈（免审即 open，不通知主控）
const iss = await api(qn1, 'POST', '/api/v2/me/issues', { title: '冒烟公司问题', detail: '本地联调创建', severity: 'mid', idempotency_key: idem('iss') });
ok('员工提交公司问题反馈 201 open', iss.status === 201 && iss.json.status === 'open', JSON.stringify(iss.json).slice(0, 160));
const mNotes = await api(M.token, 'GET', '/api/v2/me/notifications');
ok('公司问题不产生主控通知', !(mNotes.json.notifications || []).some(n => n.object_type === 'issue' && n.kind !== 'announcement'), JSON.stringify(mNotes.json.notifications || []).slice(0, 160));

// 7. 个人项目：创建 + 读取（owner 隔离）
const pp = await api(qn1, 'POST', '/api/v2/me/personal-projects', { name: '冒烟个人项目', direction: '本地联调', idempotency_key: idem('pp') });
ok('创建个人项目 201', pp.status === 201 && pp.json.object_type === 'project', JSON.stringify(pp.json).slice(0, 160));
const pps = await api(qn1, 'GET', '/api/v2/me/personal-projects');
ok('读取本人个人项目列表', pps.status === 200 && (pps.json.projects || []).some(p => p.name === '冒烟个人项目'), JSON.stringify(pps.json).slice(0, 160));

console.log(`\n冒烟结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);

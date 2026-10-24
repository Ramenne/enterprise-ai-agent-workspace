// dev/probe-token-renewal.mjs —— 定向探针：证明「身份权限服务令牌过期后，员工客户端 qn1 设备会话由服务端自动续期，客户端无需重新登录」。
// 对应用户 2026-09-10 要求：令牌失效优先自动更新，而不是逼用户重输密码。
//
// 自包含：起自己的身份权限服务替身（短 TTL）+ 资料存储服务替身 + V8 共享服务端子进程，跑完即清理；
//   不干扰 `npm run dev:backend` 的主联调实例（各用随机端口 / 独立临时库）。
// 凭据红线：只用本地虚构账号 qn_dev_a / dev-local-only，不涉及任何真实账号；
//   令牌只在本进程内存中传递，绝不写入文件、日志或交付物。
//
// 证明的机制（已逐行核准 V8-server.mjs L273-315 + notify.mjs L359-383）：
//   qn1 令牌本身不含过期时间；resolveAppSession 只在「解绑 / hash 被覆盖 / 30 天不活跃」时才失效。
//   每次 qn1 请求：取密封的身份权限服务 Bearer → verifyHufu 失败 → refreshAppAuth 用密封 refresh_token 去身份权限服务续 →
//   renewAppSession 重新密封 → touchAuthSync 刷新 30 天活跃时钟。全程对客户端透明。
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const HERE = import.meta.dirname;
const BACKEND_DIR = path.resolve(HERE, '..', '..', '..', '..', '03-代码文档', '当前实现');
const V8_ENTRY = path.join(BACKEND_DIR, 'V8-server.mjs');

// 短 TTL：让身份权限服务 access token 1.2 秒后过期，从而在探针时间尺度内触发服务端 qn1 自动续期路径。
process.env.QN_DEV_TOKEN_TTL_MS = '1200';
const { startHufuStub, startMengStub } = await import('./stubs.mjs');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  \u2192 ' + extra : '')); }
}
function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    s.on('error', rej);
  });
}
const idem = () => crypto.randomUUID();

async function main() {
  if (!fs.existsSync(V8_ENTRY)) { console.error('[probe] 找不到 V8 入口：' + V8_ENTRY); process.exit(1); }
  const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qn-token-probe-'));
  const hufu = await startHufuStub(0);   // 随机端口，短 TTL
  const meng = await startMengStub(0);
  const v8port = await freePort();
  const notifyKeys = JSON.stringify({ dev: crypto.randomBytes(32).toString('base64') });

  const child = spawn(process.execPath, [V8_ENTRY], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      V8_DB: path.join(DATA_DIR, 'v8.db'),
      V8_V2_DB: path.join(DATA_DIR, 'v8-v2.db'),
      V8_PORT: String(v8port), V8_HOST: '127.0.0.1',
      V8_HUFU_VERIFY: `${hufu.url}/hufu/auth/verify`,
      V8_HUFU_REFRESH: `${hufu.url}/hufu/auth/refresh`,
      V8_HUFU_ADMIN_ACCOUNTS: `${hufu.url}/hufu/admin/accounts`,
      V8_MAIN_CONTROL_USERNAME: 'qn_dev_m',
      V8_MENG_HOSTS: '127.0.0.1', V8_MENG_ALLOW_INSECURE: '1',
      V8_VERIFY_TIMEOUT_MS: '4000', V8_HELP_VIEW: 'http://127.0.0.1:1/views/help-v8.json',
      V8_NOTIFY_KEYS: notifyKeys, V8_NOTIFY_CURRENT_KEY: 'dev', V8_DELIVERY_TICK_MS: '2000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bootErr = '';
  child.stderr.on('data', d => { bootErr += d; });
  const base = `http://127.0.0.1:${v8port}`;
  let booted = false;
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(base + '/health'); if (r.ok) { booted = true; break; } } catch { /* 尚未就绪 */ }
    await sleep(120);
  }

  try {
    console.log('\n==== 探针：qn1 令牌自动续期（身份权限服务 Bearer 过期后无需重新登录）====');
    ok('V8 子进程启动（短 TTL 身份权限服务替身）', booted, bootErr.slice(0, 300));
    if (!booted) return;

    const USER = 'qn_dev_a', PW = 'dev-local-only';
    const H = (t, extra = {}) => ({ 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + t, ...extra });

    // 1) 身份权限服务登录：拿 B0（access）+ R0（refresh）
    const login = await (await fetch(`${hufu.url}/hufu/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: USER, password: PW }) })).json();
    ok('身份权限服务登录成功（用户名+密码）', !!login.token && !!login.refresh_token, JSON.stringify(login).slice(0, 120));
    const B0 = login.token, R0 = login.refresh_token;

    // 2) 登记设备身份（Android 无订阅）+ 用新鲜 B0/R0 换 qn1
    const inst = 'probe-renew-' + crypto.randomBytes(4).toString('hex');
    const putRes = await fetch(`${base}/api/v2/me/devices/${inst}/push-subscription`, { method: 'PUT', headers: H(B0, { 'Idempotency-Key': idem() }), body: JSON.stringify({ platform: 'android_native' }) });
    ok('设备登记 200（Android 无订阅，不阻断）', putRes.status === 200, 'status=' + putRes.status + ' ' + (await putRes.text()).slice(0, 160));
    const sess = await (await fetch(`${base}/api/v2/me/devices/${inst}/session`, { method: 'POST', headers: H(B0, { 'Idempotency-Key': idem() }), body: JSON.stringify({ refresh_token: R0 }) })).json();
    const qn1 = sess.access_token || '';
    ok('换得 qn1 设备会话', qn1.startsWith('qn1.'), JSON.stringify(sess).slice(0, 160));

    // 3) qn1 首次可用
    const bs1 = await fetch(`${base}/api/v2/me/bootstrap`, { headers: H(qn1) });
    ok('qn1 首次 bootstrap 200', bs1.status === 200, 'status=' + bs1.status);

    // 4) 等身份权限服务 B0 过期（TTL=1.2s），并直接验证 B0 确已失效
    await sleep(1800);
    const verifyB0 = await (await fetch(`${hufu.url}/hufu/auth/verify`, { headers: H(B0) })).json();
    ok('身份权限服务 B0 确已过期（verify valid=false）', verifyB0.valid === false, JSON.stringify(verifyB0));

    // 5) ★核心：qn1 仍能 bootstrap —— 服务端用密封 R0 自动续了新 Bearer，客户端全程没重登
    const bs2 = await fetch(`${base}/api/v2/me/bootstrap`, { headers: H(qn1) });
    const bs2body = await bs2.text();
    ok('\u2605 Bearer 过期后 qn1 仍 200（服务端自动续期，无需重登）', bs2.status === 200, 'status=' + bs2.status + ' ' + bs2body.slice(0, 200));

    // 6) ★再等一轮，确认续期可重复（不是只续一次；上一轮续出的 Bearer 又过期后仍能再续）
    await sleep(1500);
    const bs3 = await fetch(`${base}/api/v2/me/bootstrap`, { headers: H(qn1) });
    ok('\u2605 第二次过期后 qn1 仍 200（续期可重复）', bs3.status === 200, 'status=' + bs3.status);

    // 7) 客户端无感重换所依赖的 refresh 端点本身可用（新登录拿一个未被消费的 refresh 能换出新 Bearer）
    const login2 = await (await fetch(`${hufu.url}/hufu/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: USER, password: PW }) })).json();
    const rf = await fetch(`${hufu.url}/hufu/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: login2.refresh_token }) });
    const rfBody = await rf.json();
    ok('身份权限服务 /refresh 可用（客户端无感重换的前提）', rf.status === 200 && !!rfBody.token, 'status=' + rf.status);

    console.log(`\n==== 结果：${pass} 通过 / ${fail} 失败 ====`);
    console.log('  结论：qn1 令牌本身不过期；身份权限服务 Bearer 过期由服务端每次请求透明续期，客户端无需重新登录。');
    console.log('  唯一会要求重登的边界：设备被解绑，或连续 30 天未打开（DEVICE_EXPIRE_DAYS，策划既定的自动解绑策略，到期前有通知提醒）。');
  } finally {
    try { child.kill('SIGTERM'); } catch { /* 忽略 */ }
    try { await hufu.close(); } catch { /* 忽略 */ }
    try { await meng.close(); } catch { /* 忽略 */ }
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('[probe] 异常：', e); process.exit(1); });

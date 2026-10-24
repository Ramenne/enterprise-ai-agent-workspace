// dev/run-backend.mjs —— 一键启动“真实 V8 共享服务端 + 身份权限服务替身 + 资料存储服务替身”，供员工客户端本地联调。
// 不修改生产、不连接云端：V8-server.mjs 从共享代码区就地启动，数据库落在系统临时目录，通知密钥运行时随机生成（不落盘）。
// 用法：node dev/run-backend.mjs   （或 npm run dev:backend）
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { startHufuStub, startMengStub } from './stubs.mjs';

const HERE = import.meta.dirname;
// 共享服务端唯一位置：平台根目录 03-代码文档/当前实现（不复制进客户端工程）。
const BACKEND_DIR = path.resolve(HERE, '..', '..', '..', '..', '03-代码文档', '当前实现');
const V8_ENTRY = path.join(BACKEND_DIR, 'V8-server.mjs');

const V8_PORT = Number(process.env.V8_PORT || 8934);
const DATA_DIR = process.env.QN_DEV_DATA || path.join(os.tmpdir(), 'employeeclient-dev-backend');

async function main() {
  if (!fs.existsSync(V8_ENTRY)) {
    console.error('[dev] 找不到共享服务端入口：' + V8_ENTRY);
    console.error('[dev] 请确认平台目录结构完整（03-代码文档/当前实现/V8-server.mjs）。');
    process.exit(1);
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const hufu = await startHufuStub(Number(process.env.QN_DEV_HUFU_PORT || 8933));
  const meng = await startMengStub(0);

  // 通知密封密钥：运行时随机生成，只存在于本进程环境变量；绝不写入文件或交付物。
  const keyId = 'dev';
  const notifyKeys = JSON.stringify({ [keyId]: crypto.randomBytes(32).toString('base64') });
  const mainControl = process.env.V8_MAIN_CONTROL_USERNAME || 'qn_dev_m';

  const deadHelp = 'http://127.0.0.1:1/views/help-v8.json';   // 不可达 → /api/help 走 fallback（含 v2 通知接口地图）
  const child = spawn(process.execPath, [V8_ENTRY], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      V8_DB: path.join(DATA_DIR, 'v8.db'),
      V8_V2_DB: path.join(DATA_DIR, 'v8-v2.db'),
      V8_PORT: String(V8_PORT),
      V8_HOST: '127.0.0.1',
      V8_HUFU_VERIFY: `${hufu.url}/hufu/auth/verify`,
      V8_HUFU_REFRESH: `${hufu.url}/hufu/auth/refresh`,
      V8_HUFU_ADMIN_ACCOUNTS: `${hufu.url}/hufu/admin/accounts`,
      V8_MAIN_CONTROL_USERNAME: mainControl,
      V8_MENG_HOSTS: '127.0.0.1',
      V8_MENG_ALLOW_INSECURE: '1',
      V8_VERIFY_TIMEOUT_MS: '4000',
      V8_HELP_VIEW: deadHelp,
      V8_NOTIFY_KEYS: notifyKeys,
      V8_NOTIFY_CURRENT_KEY: keyId,
      V8_DELIVERY_TICK_MS: String(process.env.V8_DELIVERY_TICK_MS || 2000),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bootErr = '';
  child.stderr.on('data', d => { bootErr += d; process.stderr.write('[v8] ' + d); });
  child.stdout.on('data', d => process.stdout.write('[v8] ' + d));

  const base = `http://127.0.0.1:${V8_PORT}`;
  let booted = false;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + '/health'); if (r.ok) { booted = true; break; } } catch { /* 尚未就绪 */ }
    await new Promise(r => setTimeout(r, 120));
  }
  if (!booted) { console.error('[dev] V8 未启动；stderr=' + bootErr.slice(0, 800)); await shutdown(1); return; }

  // 写出联调端点（临时目录，非工作区）：seed.mjs / 浏览器测试可读取资料存储服务替身基址以构造可核验原件地址。
  try { fs.writeFileSync(path.join(DATA_DIR, 'env.json'), JSON.stringify({ v8: base, hufu: hufu.url, meng: meng.url, mainControl, password: process.env.QN_DEV_PASSWORD || 'dev-local-only' }, null, 2)); } catch { /* 忽略 */ }

  const pw = process.env.QN_DEV_PASSWORD || 'dev-local-only';
  console.log('\n================ 员工客户端本地联调后端已就绪（仅开发，非生产） ================');
  console.log('  V8 共享服务端 : ' + base + '   （/api/v2/*，/health）');
  console.log('  身份权限服务替身      : ' + hufu.url + '   （/hufu/auth/login|verify|refresh）');
  console.log('  资料存储服务替身    : ' + meng.url + '   （/f/<id> → 302）');
  console.log('  数据库(临时)  : ' + DATA_DIR);
  console.log('  唯一主控账号  : ' + mainControl);
  console.log('  ---- 本地虚构登录账号（口令统一）----');
  for (const a of hufu.accounts) console.log(`    ${a.username.padEnd(12)} 口令=${pw}}  ${a.role}${a.username === mainControl ? '（唯一主控）' : ''}  ${a.nickname}/${a.dept}`);
  console.log('  下一步：另开终端运行 `npm run dev`，Vite 会把 /api 与 /hufu 代理到上面两个服务。');
  console.log('  可选：`node dev/seed.mjs` 写入一批演示业务数据（公司项目/问题/任务/公告）。');
  console.log('========================================================================\n');

  async function shutdown(code) {
    try { child.kill('SIGTERM'); } catch {}
    try { await hufu.close(); } catch {}
    try { await meng.close(); } catch {}
    process.exit(code);
  }
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  child.on('exit', c => { console.log('[dev] V8 进程退出，code=' + c); shutdown(c || 0); });
}

main().catch(e => { console.error('[dev] 启动失败：', e); process.exit(1); });

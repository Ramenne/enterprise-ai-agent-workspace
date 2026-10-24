// dev/stubs.mjs —— 本地联调用的身份权限服务 / 资料存储服务测试替身（仅开发，绝非生产）。
// 凭据红线：不写入任何真实账号、口令或令牌。账号名与口令均来自环境变量，默认是明显的本地虚构值。
// 生产环境由真实身份权限服务提供 /hufu/auth/*，由真实资料存储服务提供 /f/<id>；本文件只在 `npm run dev:backend` 下使用。
import http from 'node:http';
import crypto from 'node:crypto';

// 本地虚构账号（可用 QN_DEV_ACCOUNTS 覆盖为 JSON 数组）。这些不是真实员工账号。
const DEFAULT_ACCOUNTS = [
  { username: 'qn_dev_a', password: 'dev-local-only', nickname: '成员甲', dept: '技术部', role: 'member' },
  { username: 'qn_dev_b', password: 'dev-local-only', nickname: '成员乙', dept: '学术部', role: 'member' },
  { username: 'qn_dev_m', password: 'dev-local-only', nickname: '本地主控', dept: '主管', role: 'admin' },
];

function loadAccounts() {
  let list = DEFAULT_ACCOUNTS;
  if (process.env.QN_DEV_ACCOUNTS) {
    try { const p = JSON.parse(process.env.QN_DEV_ACCOUNTS); if (Array.isArray(p) && p.length) list = p; } catch { /* 保持默认 */ }
  }
  // 统一口令来自环境（默认明显的本地占位，非真实凭据）；也支持每账号 password 字段。
  const pw = process.env.QN_DEV_PASSWORD || 'dev-local-only';
  return list.map(a => ({ ...a, password: a.password || pw }));
}

// 启动身份权限服务替身：login / verify / refresh / admin-accounts。返回 { port, close, url }。
export async function startHufuStub(port = 0) {
  const accounts = loadAccounts();
  const byUser = u => accounts.find(a => a.username === u);
  const tokens = new Map();       // access token -> username
  const refresh = new Map();      // refresh token -> username
  const ttl = Number(process.env.QN_DEV_TOKEN_TTL_MS || 0);   // 0=不过期（便于本地联调）
  const issued = new Map();       // token -> issuedAt

  const server = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
    const tok = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    const valid = t => {
      const u = tokens.get(t); if (!u) return null;
      if (ttl && Date.now() - (issued.get(t) || 0) > ttl) { tokens.delete(t); return null; }
      return u;
    };
    if (req.method === 'POST' && req.url === '/hufu/auth/login') {
      let b = ''; req.on('data', c => b += c); req.on('end', () => {
        let j = {}; try { j = JSON.parse(b || '{}'); } catch {}
        const acc = byUser(String(j.username || ''));
        if (!acc || acc.password !== String(j.password || '')) return send(401, { error: 'bad_credentials' });
        const token = 'qnstub-a.' + crypto.randomBytes(18).toString('base64url');
        const rt = 'qnstub-r.' + crypto.randomBytes(18).toString('base64url');
        tokens.set(token, acc.username); issued.set(token, Date.now()); refresh.set(rt, acc.username);
        send(200, { token, refresh_token: rt, username: acc.username, nickname: acc.nickname, dept: acc.dept, role: acc.role });
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/hufu/auth/verify') {
      const u = valid(tok); if (!u) return send(200, { valid: false });
      const acc = byUser(u); return send(200, { valid: true, username: u, nickname: acc.nickname, dept: acc.dept, role: acc.role });
    }
    if (req.method === 'POST' && req.url === '/hufu/auth/refresh') {
      let b = ''; req.on('data', c => b += c); req.on('end', () => {
        let j = {}; try { j = JSON.parse(b || '{}'); } catch {}
        const u = refresh.get(String(j.refresh_token || '')); if (!u) return send(401, { error: 'invalid_refresh' });
        refresh.delete(j.refresh_token);
        const token = 'qnstub-a.' + crypto.randomBytes(18).toString('base64url');
        const rt = 'qnstub-r.' + crypto.randomBytes(18).toString('base64url');
        tokens.set(token, u); issued.set(token, Date.now()); refresh.set(rt, u);
        send(200, { token, refresh_token: rt });
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/hufu/admin/accounts') {
      const u = valid(tok); const acc = u ? byUser(u) : null;
      if (!acc || acc.role !== 'admin') return send(403, { error: 'admin_only' });
      return send(200, { accounts: accounts.map(a => ({ username: a.username, nickname: a.nickname, dept: a.dept, role: a.role })) });
    }
    if (req.method === 'GET' && req.url === '/hufu/health') return send(200, { ok: true, service: 'hufu-stub', dev_only: true });
    send(404, { error: 'not_found' });
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  const p = server.address().port;
  return { port: p, url: `http://127.0.0.1:${p}`, close: () => new Promise(r => server.close(r)), accounts };
}

// 启动资料存储服务替身：任意 /f/<id> 返回 302（代表原件存在）。返回 { port, close, url, address(id) }。
export async function startMengStub(port = 0) {
  const server = http.createServer((req, res) => {
    const id = (req.url.split('/f/')[1] || '').split('?')[0];
    if (!id) { res.writeHead(404); return res.end('not_found'); }
    res.writeHead(302, { Location: `http://127.0.0.1:${server.address().port}/blob/${id}` });
    res.end();
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  const p = server.address().port;
  return { port: p, url: `http://127.0.0.1:${p}`, close: () => new Promise(r => server.close(r)), address: id => `http://127.0.0.1:${p}/f/${id}` };
}

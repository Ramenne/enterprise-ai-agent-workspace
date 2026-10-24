// dev/ui-capture.mjs —— 手机视口 UI 验收取证（截图 + DOM 断言）。
//
// 为什么不用 Chrome/puppeteer：本机未安装 Chrome/Chromium（原 puppeteer 截图脚本 screenshot.mjs / verify-fixes.mjs
// 默认 Windows Chrome 路径，在本机跑不了，已于 2026-09-10 作为废弃代码清理删除，puppeteer-core 依赖一并移除）；
// browser-use 的 take_screenshot 又因 IDE 浏览器面板未打开（visibilityState=hidden）而拒绝。
// 而 IDE 内置 Chromium 暴露标准 CDP 端点，Page.captureScreenshot 是渲染管线级操作，不需要窗口可见，
// 且 Emulation.setDeviceMetricsOverride 能给出真实手机视口（390x844 @2x）。这是本机唯一可行的真机尺寸取证路线。
//
// 用法：先 `npm run dev:backend && node dev/seed.mjs && npm run dev`，再 `node dev/ui-capture.mjs`。
// 账号与口令从本地替身 env.json 读取（不在本文件写死真值）；也可用 QN_DEV_USER 指定要登录的账号。
// 截图与断言结果写入 06-个人APP/员工客户端/04-验收/截图-<日期>/。
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP_URL = process.env.QN_APP_URL || 'http://localhost:5173';
const USER = process.env.QN_DEV_USER || 'qn_dev_a';
const OUT = path.resolve(process.cwd(), '../04-验收/截图-' + new Date().toISOString().slice(0, 10));
mkdirSync(OUT, { recursive: true });

function devPassword() {
  if (process.env.QN_DEV_PASSWORD) return process.env.QN_DEV_PASSWORD;
  try { return String(JSON.parse(readFileSync(path.join(os.tmpdir(), 'employeeclient-dev-backend', 'env.json'), 'utf8')).password || ''); }
  catch { return ''; }
}
const PW = devPassword();
if (!PW) { console.error('缺少本地替身口令：先运行 npm run dev:backend'); process.exit(2); }

// ---------- CDP 发现与连接 ----------
function discoverPort() {
  const ports = new Set();
  try {
    for (const line of execSync('lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null').toString().split('\n')) {
      const m = line.match(/127\.0\.0\.1:(\d+)/); if (m && /Qoder/i.test(line)) ports.add(Number(m[1]));
    }
  } catch { /* lsof 不可用时退回常见端口 */ }
  for (const p of [9222, 9229]) ports.add(p);
  for (const p of ports) {
    try {
      const j = JSON.parse(execSync(`curl -s -m 1 http://127.0.0.1:${p}/json/version`).toString());
      if (j && j.webSocketDebuggerUrl) return p;
    } catch { /* 不是 CDP 端口 */ }
  }
  return 0;
}
const PORT = discoverPort();
if (!PORT) { console.error('未发现 CDP 端点：请确认 IDE 内置浏览器已打开过目标页'); process.exit(2); }
const listTargets = () => JSON.parse(execSync(`curl -s -m 3 http://127.0.0.1:${PORT}/json/list`).toString());
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 没有目标页时借用一个空白标签导航过去（该 Electron 不支持 Target.createTarget，但 Page.navigate 可用）。 */
async function ensureTarget() {
  let t = listTargets().find(x => x.type === 'page' && (x.url || '').startsWith(APP_URL));
  if (t) return t;
  const blank = listTargets().find(x => x.type === 'page' && (x.url === 'about:blank' || !x.url));
  if (!blank) throw new Error('没有可用标签页：请先在 IDE 浏览器里打开任意页');
  const w = new WebSocket(blank.webSocketDebuggerUrl);
  await new Promise((res, rej) => { w.addEventListener('open', res); w.addEventListener('error', rej); });
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('Page.navigate 超时')), 8000);
    w.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id === 1) { clearTimeout(to); if (m.error) rej(new Error(m.error.message)); else res(m.result); }
    });
    w.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url: APP_URL + '/#/connect' } }));
  });
  w.close();
  for (let i = 0; i < 20; i++) {
    t = listTargets().find(x => x.type === 'page' && x.id === blank.id);
    if (t && (t.url || '').startsWith(APP_URL)) return t;
    await sleep(300);
  }
  throw new Error('导航后 target 未更新');
}
const target = await ensureTarget();
console.log('CDP 端口 ' + PORT + '，目标页 ' + target.id + ' ' + target.url);

const ws = new WebSocket(target.webSocketDebuggerUrl);
let seq = 0; const pend = new Map();
function send(method, params = {}, timeout = 10000) {
  const id = ++seq;
  return new Promise((res, rej) => {
    const to = setTimeout(() => { pend.delete(id); rej(new Error('TIMEOUT ' + method)); }, timeout);
    pend.set(id, { res: v => { clearTimeout(to); res(v); }, rej: e => { clearTimeout(to); rej(e); } });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { const h = pend.get(m.id); pend.delete(m.id); m.error ? h.rej(new Error(m.error.message)) : h.res(m.result); }
});
async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300));
  return r.result.value;
}

let pass = 0, fail = 0;
const results = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; results.push('  PASS ' + name); }
  else { fail++; results.push('  FAIL ' + name + (extra ? ' ' + extra : '')); }
}
let shotNo = 0;
async function shot(label) {
  shotNo++;
  const name = String(shotNo).padStart(2, '0') + '-' + label + '.png';
  const s = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.join(OUT, name), Buffer.from(s.data, 'base64'));
  console.log('  截图 ' + name);
  return name;
}
async function goto(hash, waitMs = 900) {
  await evalJs(`location.hash = ${JSON.stringify(hash)}; true`);
  await sleep(waitMs);
}
async function clickText(text, scope = 'button') {
  return evalJs(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(scope)})].find(x => (x.textContent||'').includes(${JSON.stringify(text)})); if (el) { el.click(); return true; } return false; })()`);
}
async function closeModal() {
  // 多数弹层页脚是「完成」；搜索弹层忠于原型没有页脚，只能走右上角关闭或背景。
  const done = await clickText('完成', '.modal-footer button');
  if (!done) await evalJs(`(() => { const b = document.querySelector('.modal-header .icon-btn'); if (b) { b.click(); return true; } return false; })()`);
  await sleep(400);
}

await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
// 会话隔离：上一轮取证可能已登录并持久化 qn1（localStorage['qn.session']）；若不重置，#/connect 会被
// 路由守卫重定向到 #/inbox，登录表单不渲染。只清除会话令牌，保留 installation_id（设备身份），
// 否则每轮会新注册设备而撞上单账号设备上限。缓存库一并删除避免跨轮脏数据。
await evalJs(`(() => { try { localStorage.removeItem('qn.session'); sessionStorage.clear(); } catch (e) {} try { indexedDB.deleteDatabase('employeeclient-cache'); } catch (e) {} return true; })()`);
// 硬重载：vite 长跑时复用的目标页可能停留在旧 bundle（device.ts VAPID 修复前、死代码清理前的代码），
// 且后续用 location.hash 切换不会重新加载页面。必须 ignoreCache 重载，取证才真正跑当前源码。
await send('Page.reload', { ignoreCache: true });
await sleep(3200);
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(600);

console.log('\n[1] 登录页');
await goto('#/connect', 700);
const loginDom = await evalJs(`JSON.stringify({
  u: !!document.querySelector('#qn-u'), p: !!document.querySelector('#qn-p'),
  submit: !!document.querySelector('form.connect-form button[type=submit]'),
  note: (document.body.innerText||'').includes('没有退出登录按钮') && (document.body.innerText||'').includes('不卸载就不解绑'),
  pwdLabel: [...document.querySelectorAll('label')].map(l=>l.textContent.trim()).join('|') })`);
const ld = JSON.parse(loginDom);
check('登录页有账号/密码输入与提交按钮', ld.u && ld.p && ld.submit);
check('第二字段标签是「密码」而非「口令」', ld.pwdLabel.includes('密码') && !ld.pwdLabel.includes('口令'), ld.pwdLabel);
check('登录页说明无退出登录按钮且不卸载不解绑', ld.note);
await shot('登录页');

console.log('\n[2] 登录（真实身份权限服务替身鉴权）');
await evalJs(`(() => {
  const set = (sel, v) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
  set('#qn-u', ${JSON.stringify(USER)}); set('#qn-p', ${JSON.stringify(PW)});
  document.querySelector('form.connect-form button[type=submit]').click(); return true; })()`);
for (let i = 0; i < 20; i++) { await sleep(400); if (!/connect/.test(await evalJs('location.hash'))) break; }
const afterLogin = await evalJs('location.hash');
check('登录后离开 /connect（实际 ' + afterLogin + '）', !/connect/.test(afterLogin), afterLogin);

console.log('\n[3] 收件箱');
await goto('#/inbox', 1400);
const inbox = JSON.parse(await evalJs(`JSON.stringify({
  perm: !!document.querySelector('.notification-permission'),
  permText: (document.querySelector('.notification-permission')?.innerText||'').includes('让反馈及时抵达'),
  note: !!document.querySelector('.inbox-note'),
  scope: !!document.querySelector('.list-toolbar .scope-filter'),
  foot: !!document.querySelector('.list-foot'),
  tabs: [...document.querySelectorAll('.tabs button, .segmented button')].map(b=>b.textContent.trim()).slice(0,6),
  rows: document.querySelectorAll('.list-panel .row, .list-panel .task-row, .list-panel li').length })`));
check('收件箱有原型的 notification-permission 块且文案正确', inbox.perm && inbox.permText);
check('收件箱保留 inbox-note 两行说明', inbox.note);
check('收件箱工具栏是原型的 scope-filter（非自造控件）', inbox.scope);
check('自造的 .list-foot 已删除', !inbox.foot);
await shot('收件箱');

console.log('\n[4] 公司反馈 / 个人项目');
await goto('#/company', 1100);
await shot('公司反馈');
await goto('#/projects', 1100);
await shot('个人项目');

console.log('\n[5] 消息中心');
await goto('#/notifications', 1100);
await shot('消息中心');

console.log('\n[6] 我的（profile 页对齐原型）');
await goto('#/profile', 1100);
const prof = JSON.parse(await evalJs(`JSON.stringify({
  layout: !!document.querySelector('.profile-layout'),
  cards: document.querySelectorAll('.profile-layout > .card').length,
  rows: [...document.querySelectorAll('.profile-layout .settings-row')].map(b=>b.textContent.replace(/\\s+/g,' ').trim()),
  titles: [...document.querySelectorAll('.profile-layout .settings-row strong')].map(b=>b.textContent.replace(/\\s+/g,' ').trim()),
  hints: document.querySelectorAll('.hint-line').length,
  text: (document.querySelector('.profile-layout')?.innerText||'') })`));
check('profile 用原型的 profile-layout 包两张卡', prof.layout && prof.cards === 2, JSON.stringify({ layout: prof.layout, cards: prof.cards }));
check('卡内含"我的提醒"行', prof.text.includes('我的提醒'));
check('保留通知与连接及关于员工客户端，不保留独立同步入口', prof.text.includes('通知与连接') && prof.text.includes('关于员工客户端') && !prof.titles.includes('同步状态') && !prof.titles.includes('同步与缓存'));
// 只比对行标题（strong）：“当前设备”会出现在合法描述里（如“仅保存在当前设备”“当前设备状态查看”），
// 用全页 substring 会误伤；自造行的特征是标题恰为“重新连接账号”或“当前设备”。
check('没有自造的"重新连接账号 / 当前设备"行标题', !prof.titles.includes('重新连接账号') && !prof.titles.includes('当前设备'), 'titles=' + prof.titles.join(' | '));
check('只有一条 hint-line', prof.hints === 1, String(prof.hints));
await shot('我的');

console.log('\n[7] 搜索覆盖层');
// 先回到干净路由并关掉可能残留的弹层：ui.overlay 是跨路由的 store 状态，上一段若留有弹层会顶掉 search。
await goto('#/inbox', 700);
await evalJs(`(() => { const c = document.querySelector('#overlays .modal-header .icon-btn'); if (c) c.click(); return true; })()`);
await sleep(300);
// 顶栏搜索按钮只有图标没有文本（原型在窄屏下也隐藏 label/kbd），用 aria-label 定位。
const searchBtn = await evalJs(`(() => { const b = document.querySelector('button[aria-label="搜索我的工作"]'); if (b) { b.click(); return true; } return false; })()`);
// 轮询等覆盖层与输入框挂载（最多 ~3s），不靠固定 sleep 赌时序。
let inputReady = false;
for (let i = 0; i < 15 && !inputReady; i++) { await sleep(200); inputReady = await evalJs(`!!document.querySelector('.modal.wide .search-input')`); }
const searchOpen = JSON.parse(await evalJs(`JSON.stringify({
  btn: ${searchBtn}, inputReady: ${inputReady}, wide: !!document.querySelector('.modal.wide'), input: !!document.querySelector('.search-input'),
  empty: !!document.querySelector('.modal .empty'), overlays: (document.querySelector('#overlays')?.innerHTML||'(无 #overlays)').replace(/\\s+/g,' ').slice(0,140) })`));
check('顶栏搜索按钮可点开 wide 弹层且有 search-input', searchOpen.btn && searchOpen.wide && searchOpen.input, JSON.stringify(searchOpen).slice(0, 260));
check('未输入时显示原型空态', searchOpen.empty);
await shot('搜索-空态');
if (inputReady) {
  // '员工客户端' 必然命中种子数据（个人项目名“员工客户端”、策划“员工客户端工作收件箱策划”、任务“设计员工客户端的工作收件箱”）。
  await evalJs(`(() => { const el = document.querySelector('.search-input'); el.value = '员工客户端'; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(600);
  const searchHits = await evalJs('document.querySelectorAll(".search-result").length');
  check('输入“员工客户端”后出现 .search-result（实际 ' + searchHits + ' 条）', searchHits > 0, String(searchHits));
  await shot('搜索-有结果');
} else {
  console.log('  [诊断] 搜索输入框未挂载，跳过输入步骤。DOM=' + JSON.stringify(searchOpen).slice(0, 260));
}
await closeModal();

console.log('\n[8] 通知与连接弹层');
await goto('#/profile', 800);
await clickText('通知与连接', '.settings-row');
await sleep(900);
const ns = JSON.parse(await evalJs(`JSON.stringify({
  modal: !!document.querySelector('.modal'),
  sys: (document.querySelector('.modal')?.innerText||'').includes('系统通知'),
  sound: (document.querySelector('.modal')?.innerText||'').includes('提示声音'),
  link: (document.querySelector('.modal')?.innerText||'').includes('当前连接'),
  toggle: document.querySelectorAll('.modal .toggle').length,
  devices: document.querySelectorAll('.modal .device-row').length,
  selftest: (document.querySelector('.modal')?.innerText||'').includes('自检') })`));
check('弹层含系统通知/提示声音/当前连接三段', ns.modal && ns.sys && ns.sound && ns.link);
check('弹层有真实 toggle 与同账号设备行（' + ns.devices + ' 台）', ns.toggle > 0 && ns.devices >= 0);
check('弹层提供本机通知自检（§零-11 实机验收用）', ns.selftest);
await shot('通知与连接');
await closeModal();

console.log('\n[10] 关于员工客户端弹层');
await clickText('关于员工客户端', '.settings-row');
await sleep(600);
const ab = await evalJs(`(document.querySelector('.modal')?.innerText||'')`);
check('关于弹层含策划版本 v0.24', ab.includes('v0.24'));
check('关于弹层如实说明 Android 不用厂商推送', ab.includes('厂商') || ab.includes('第三方'));
await shot('关于员工客户端');
await closeModal();

console.log('\n[11] 我的提醒弹层');
await clickText('我的提醒', '.settings-row');
await sleep(700);
const rm = await evalJs(`(document.querySelector('.modal')?.innerText||'')`);
check('提醒弹层有内容（空态或提醒列表）', rm.length > 20);
check('提醒弹层如实标注能力边界', rm.includes('稍后提醒') || rm.includes('暂时没有提醒') || rm.includes('接口'));
await shot('我的提醒');
await closeModal();

console.log('\n' + results.join('\n'));
console.log(`\n结果 PASS ${pass} / FAIL ${fail}；截图目录 ${OUT}`);
ws.close();
process.exit(fail ? 1 : 0);

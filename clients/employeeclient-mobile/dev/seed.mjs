// dev/seed.mjs —— 向本地联调后端写入一批真实业务数据（经产品 API，不直连数据库），供员工客户端联调。
// 覆盖：公司项目、公司问题反馈、直接代码待审(→主控待审通知)、协作声明(→提交人协作通知)、公司公告、个人项目。
// 先运行 `npm run dev:backend`。用法：node dev/seed.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 从联调后端写出的临时 env.json 读取真实端口（资料存储服务替身为随机端口）；缺失时退回默认。
let envJson = {};
try { envJson = JSON.parse(fs.readFileSync(path.join(process.env.QN_DEV_DATA || path.join(os.tmpdir(), 'employeeclient-dev-backend'), 'env.json'), 'utf8')); } catch { /* 忽略 */ }
const V8 = process.env.V8_BASE || envJson.v8 || 'http://127.0.0.1:8934';
const HUFU = process.env.QN_DEV_HUFU_BASE || envJson.hufu || 'http://127.0.0.1:8933';
const PW = process.env.QN_DEV_PASSWORD || envJson.password || 'dev-local-only';
const MENG = process.env.QN_DEV_MENG || envJson.meng || '';   // 资料存储服务替身基址（用于直接代码原件核验）
const idem = k => 'seed-' + k + '-' + crypto.randomBytes(3).toString('hex');
const SHA = 'a'.repeat(64);

async function login(username) {
  const r = await fetch(HUFU + '/hufu/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PW }) });
  const j = await r.json(); if (!r.ok) throw new Error('login failed ' + username); return j;
}
async function api(token, method, p, body) {
  const h = { Authorization: 'Bearer ' + token };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(V8 + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = {}; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}

const A = await login('qn_dev_a'), B = await login('qn_dev_b'), M = await login('qn_dev_m');
const log = (...a) => console.log(...a);

// 1. 主控创建公司项目
const proj = await api(M.token, 'POST', '/api/v2/control/projects', { name: '企业 AI 协作平台 · 移动端', direction: '员工客户端与共享通知', idempotency_key: idem('proj') });
const projectId = proj.json.object_id;
log('公司项目:', proj.status, projectId);

// 2. 员工提交公司问题反馈（免审即 open，不通知主控）
const iss1 = await api(A.token, 'POST', '/api/v2/me/issues', { title: '任务审核反馈在列表里不够醒目', detail: '策划被要求修改后，列表与普通记录样式接近，希望打开就能看清下一步。', severity: 'mid', idempotency_key: idem('iss1') });
const iss2 = await api(B.token, 'POST', '/api/v2/me/issues', { title: '大文件上传中断后希望能续传', detail: '电脑 Agent 提交原件时网络短暂中断，希望保留进度并支持重试。', severity: 'high', idempotency_key: idem('iss2') });
log('公司问题:', iss1.status, iss1.json.object_id, iss2.status, iss2.json.object_id);

// 3. 员工提交直接代码（创建 Task + 待审代码 → 主控待审通知）
const addr = MENG ? MENG + '/f/seedcode01' : undefined;
const dcBody = { project_id: projectId, title: '让审核反馈在收件箱中清晰可见', delivery_kind: 'code', sha256: SHA, issue_links: [{ issue_id: iss1.json.object_id, resolution_scope: 'complete' }], idempotency_key: idem('dc1') };
if (addr) dcBody.address = addr;
const dc = await api(A.token, 'POST', '/api/v2/me/code-submissions/direct', dcBody);
const taskId = dc.json.created_task_ids && dc.json.created_task_ids[0];
log('直接代码 Task:', dc.status, taskId, dc.json.error || '');

// 4. 另一名员工对公司问题声明处理（→ 提交人协作通知）
if (iss1.json.object_id) {
  const he = await api(B.token, 'POST', `/api/v2/me/issues/${iss1.json.object_id}/handling-events`, { resolution_scope: 'partial', note: '我先处理审核反馈的列表样式', idempotency_key: idem('he1') });
  log('协作声明:', he.status);
}

// 5. 员工催促主控审核（若 Task 处于待审）→ 主控 urgent 悬浮
if (taskId) {
  const urge = await api(A.token, 'POST', `/api/v2/me/tasks/${taskId}/review-urge`, { message: '这条会影响本周交付，请优先看一下', idempotency_key: idem('urge1') });
  log('催促主控:', urge.status, urge.json.status || urge.json.error || '');
}

// 6. 主控发布公告给两名员工（→ 收件人未读公告悬浮；发布者不接收）
const ann = await api(M.token, 'POST', '/api/v2/control/announcements', { title: '本周研发协作小提醒', body: '提交策划或代码后，请以中枢回执为准。等待主控审核时，可在任务“更多”中选择“催促主控审核”。个人项目仍然只对自己可见。', priority: 'normal', recipient_usernames: ['qn_dev_a', 'qn_dev_b'], idempotency_key: idem('ann1') });
log('公司公告:', ann.status, 'recipients=' + (ann.json.recipient_count ?? ''));

// 7. 员工个人项目 + 完整 personal 链（个人问题/策划想法 → 个人策划 owner 自动生效 → 个人直接代码 owner 自动完成）
const pp = await api(A.token, 'POST', '/api/v2/me/personal-projects', { name: '员工客户端', direction: '让每一件事，都有回音', idempotency_key: idem('pp1') });
const ppId = pp.json.object_id;
log('个人项目:', pp.status, ppId);
const pi1 = await api(A.token, 'POST', '/api/v2/me/issues', { title: '收件箱的紧急事项应该一眼看见', detail: '少一些数字，多一些明确的下一步。', severity: 'mid', scope: 'personal', project_id: ppId, intake_kind: 'plan_idea', idempotency_key: idem('pi1') });
const pi2 = await api(A.token, 'POST', '/api/v2/me/issues', { title: '给阅读笔记加一个原文出处', detail: '记录时附上链接，之后更容易找回。', severity: 'low', scope: 'personal', project_id: ppId, intake_kind: 'problem', idempotency_key: idem('pi2') });
log('个人问题/想法:', pi1.status, pi1.json.object_id, pi2.status, pi2.json.object_id);
if (MENG) {
  // 个人正式策划（模拟电脑端 Agent 用 A 账号提交）→ owner 同事务自动生效
  const ppl = await api(A.token, 'POST', '/api/v2/me/plan-submissions', { title: '员工客户端工作收件箱策划', address: MENG + '/f/seedplan01', summary: '私人策划', items: [{ title: '设计员工客户端的工作收件箱', project_id: ppId, assignee_username: 'qn_dev_a', issue_links: [{ issue_id: pi1.json.object_id, resolution_scope: 'complete' }] }], idempotency_key: idem('pplan') });
  log('个人策划(自动生效):', ppl.status, ppl.json.status, 'task=' + ((ppl.json.created_task_ids || [])[0] || ''));
  // 个人直接代码 → owner 自动完成，并解决关联个人问题
  const pdc = await api(A.token, 'POST', '/api/v2/me/code-submissions/direct', { project_id: ppId, title: '整理笔记标题显示', delivery_kind: 'code', address: MENG + '/f/seedpcode01', sha256: SHA, issue_links: [{ issue_id: pi2.json.object_id, resolution_scope: 'complete' }], idempotency_key: idem('pdc') });
  log('个人直接代码(自动完成):', pdc.status, pdc.json.status);
}

// 8. 主控视角确认待审队列
const q = await api(M.token, 'GET', '/api/v2/control/queues');
log('主控待审队列:', JSON.stringify(q.json.queues));
log('\n种子数据写入完成。可在员工客户端用 qn_dev_a / qn_dev_b / qn_dev_m 登录观察。');

import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {central,signin,authenticate,logout,allow,configureSessions} from './hufu-auth.mjs';
import {createHistory} from './account-history.mjs';
import {createVault} from './account-vault.mjs';
import {createHtmlLibrary,htmlLibraryHandler} from './html-library.mjs';
import {createSkillLibrary,skillLibraryHandler} from './skill-library.mjs';
import {createKnowledgeLibrary,knowledgeLibraryHandler} from './knowledge-library.mjs';
import {createAgentApi,agentApiHandler} from './agent-api.mjs';
import {createAgentCollector} from './agent-collector.mjs';
import {createHardwareAdapter} from './agent-hardware.mjs';
import {createHardware,hardwareHandler} from './hardware.mjs';
import {createAccessControl,isAdmin} from './access-control.mjs';
import {readFile,stat} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
const origin='https://tools.example.invalid/';
if(!origin)throw Error('Required private environment missing');
const allowedOrigins=new Set([origin,process.env.LEGACY_ORIGIN].filter(Boolean));

const db=new DatabaseSync(process.env.DATA_PATH||'/srv/workspace');
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON');
configureSessions(db);
const access=createAccessControl(db);
const history=createHistory(db);
try{for(const member of JSON.parse(await readFile(new URL('./members.json',import.meta.url))).members)history.rememberName(member.actor_id,member.display_name)}catch{}
history.rememberName('0a664193-f099-408b-ad91-f7fc39fa98e2','Member A');history.rememberName('46b19322-b0f9-490c-ad90-47989799fd74','Member B');
const vault=createVault(db,{shared:true,access});
const htmlStore=createHtmlLibrary(db),skillStore=createSkillLibrary(db),knowledgeStore=createKnowledgeLibrary(db);
const hardwareStore=createHardware(db);
const hardware=hardwareHandler(hardwareStore);
const htmlLibrary=htmlLibraryHandler(htmlStore);
const skillLibrary=skillLibraryHandler(skillStore);
const knowledgeLibrary=knowledgeLibraryHandler(knowledgeStore);
const agentApi=agentApiHandler(createAgentApi(db,{knowledge:knowledgeStore,skills:skillStore,html:htmlStore,vault,access,collector:createAgentCollector(db),extensions:[createHardwareAdapter(hardwareStore,{version:'20261014d',ready:true})]}));
const root=resolve(fileURLToPath(new URL('./web-dist',import.meta.url)));
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data))};
const redirect=(res,path)=>{res.writeHead(303,{Location:path,'Cache-Control':'no-store'});res.end()};
async function body(req){let s='';for await(const b of req){s+=b;if(Buffer.byteLength(s)>30000)throw Error('large')}return s}
const loginHtml=(error,nonce)=>`<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta charset="utf-8"><meta name="referrer" content="same-origin"><title>登录 · 协作平台工具合集</title><link rel="stylesheet" href="/static/home.css?v=20261012f"><style>.login{max-width:420px;margin:76px auto;padding:0 24px}.login h2{font-size:24px;margin:0 0 8px}.intro{margin:0 0 32px;color:#85858a;font-size:13px}label{display:block;font-size:13px;font-weight:500;margin:22px 0 8px}input,button{font:inherit}input{width:100%;height:46px;border:1px solid #dcdce2;border-radius:10px;padding:11px 14px;background:#fdfdfd;color:#252526;outline:none}input:focus{border-color:#78b7ff;box-shadow:0 0 0 3px #007aff0c}input::placeholder{color:#99999f}.code-row{display:flex;gap:10px}.code-row input{min-width:0;flex:1}button{cursor:pointer;border:0;border-radius:9px;white-space:nowrap;transition:background .15s}#send{padding:0 14px;color:#007aff;background:transparent}#send:hover{background:#ededf0}button:focus-visible{outline:3px solid #80bbff;outline-offset:2px}button:disabled{opacity:.4;cursor:default}.submit{width:100%;height:44px;background:#007aff;color:#fff;font-weight:500;margin-top:28px}.submit:hover{background:#006ce4}#feedback{font-size:12px;color:#85858a;margin:8px 0 0;line-height:1.7}#feedback:empty{display:none}.error{color:#a44c16;font-size:12px;line-height:1.7}.remember{margin-top:16px;text-align:center;font-size:12px;color:#85858a}@media(max-width:720px){.login{margin-top:48px}}</style><link rel="icon" href="/favicon.ico?v=20261012" sizes="any"><link rel="icon" href="/static/icons/favicon.svg?v=20261012" type="image/svg+xml"><link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png?v=20261012"><link rel="mask-icon" href="/static/icons/safari-pinned-tab.svg?v=20261012" color="#007aff"><link rel="manifest" href="/site.webmanifest?v=20261012"><meta name="theme-color" content="#fafafa"><meta name="apple-mobile-web-app-title" content="协作平台工具合集"></head><body><header><span class="tool-logo" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="7" height="7" rx="2" stroke="currentColor" stroke-width="1.6"/><rect x="14" y="3" width="7" height="7" rx="2" fill="#007aff"/><rect x="3" y="14" width="7" height="7" rx="2" stroke="currentColor" stroke-width="1.6"/><rect x="14" y="14" width="7" height="7" rx="2" stroke="currentColor" stroke-width="1.6"/></svg></span><h1>协作平台工具合集</h1></header><main class="login"><h2>登录</h2><p class="intro">使用身份权限服务成员邮箱，登录后使用全部工具。</p>${error?'<p class="error" role="alert">邮箱或验证码不正确，请重试。</p>':''}<form method="post" action="/login"><label for="email">成员邮箱</label><input id="email" name="email" type="email" autocomplete="email" placeholder="输入成员邮箱" required maxlength="254"><label for="otp">验证码</label><div class="code-row"><input id="otp" name="otp" inputmode="numeric" autocomplete="one-time-code" placeholder="6位验证码" required pattern="[0-9]{6}" maxlength="6"><button type="button" id="send">获取验证码</button></div><p id="feedback" role="status" aria-live="polite"></p><button class="submit" type="submit">登录</button></form><script nonce="${nonce}">document.getElementById('send').onclick=async function(){const btn=this,email=document.querySelector('[name=email]');if(!email.reportValidity())return;btn.disabled=true;const msg=document.getElementById('feedback');try{const r=await fetch('/auth/send-code',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:email.value})});msg.textContent=r.ok?'验证码已请求，请检查本人邮箱。':'验证码暂时无法发送，请稍后重试。'}catch{msg.textContent='连接失败，请稍后重试。'}setTimeout(()=>btn.disabled=false,60000)};document.querySelector('form').addEventListener('submit',async function(event){event.preventDefault();const button=this.querySelector('[type=submit]'),feedback=document.getElementById('feedback');button.disabled=true;try{const response=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(new FormData(this)),credentials:'same-origin'});if(response.ok&&response.redirected){window.location.assign(response.url);return}feedback.textContent=response.status===429?'请求过于频繁，请稍后重试。':'登录暂时无法完成，请刷新后重试。'}catch{feedback.textContent='连接失败，请稍后重试。'}button.disabled=false});</script><p class="remember">保持登录，主动退出或撤销授权后失效</p></main></body></html>`;
async function handler(req,res){const url=new URL(req.url,origin);const accountRoute=url.pathname.startsWith('/accounts/');const path=accountRoute?url.pathname.slice('/accounts'.length):url.pathname;const nonce=randomBytes(18).toString('base64');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','same-origin');res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'`);
if(!accountRoute&&path.startsWith('/agent/v1/'))return agentApi(req,res,url);
if(!accountRoute&&path==='/auth/check'){const member=await authenticate(req,res);res.writeHead(member?204:401,{'Cache-Control':'no-store'});return res.end()}
if(accountRoute&&path==='/login')return redirect(res,'/login');
if(path==='/healthz'&&req.method==='GET')return json(res,200,{status:'ok'});
if(path==='/login'&&req.method==='GET'){if(await authenticate(req,res))return redirect(res,'/');res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end(loginHtml(url.searchParams.get('error'),nonce))}
if(req.method==='POST'&&!allowedOrigins.has(req.headers.origin))return json(res,403,{error:'请求来源无效'});
if(path==='/auth/send-code'&&req.method==='POST'){if(!allow(req.headers['x-real-ip']||req.socket.remoteAddress))return json(res,429,{error:'请求过于频繁，请稍后再试'});let b;try{b=JSON.parse(await body(req))}catch{return json(res,400,{error:'请求格式无效'})}if(typeof b.email!=='string'||b.email.length>254||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email))return json(res,400,{error:'请输入成员邮箱'});const r=await central('/v2/auth/email-otp/send-verification-otp',{body:{email:b.email,type:'sign-in'}});return json(res,r.ok?200:400,{message:r.ok?'验证码已请求':'验证码暂时无法发送'})}
if(path==='/login'&&req.method==='POST'){if(!allow(req.headers['x-real-ip']||req.socket.remoteAddress))return json(res,429,{error:'请求过于频繁，请稍后再试'});const f=new URLSearchParams(await body(req));const email=f.get('email')||'',otp=f.get('otp')||'';if(email.length>254||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||! /^[0-9]{6}$/.test(otp))return redirect(res,'/login?error=1');const session=await signin(email,otp);if(!session)return redirect(res,'/login?error=1');res.setHeader('Set-Cookie',`tools_session=${session.token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${session.maxAge}`);return redirect(res,'/')}
if(path==='/logout'&&req.method==='POST'){await logout(req);res.setHeader('Set-Cookie','tools_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');return redirect(res,'/login')}
const member=await authenticate(req,res);if(!member){if(path.startsWith('/api/')||path.startsWith('/html/api/')||path.startsWith('/skills/api/')||path.startsWith('/knowledge/api/')||path.startsWith('/hardware/api/'))return json(res,401,{error:'请先登录'});return redirect(res,'/login')}const owner=member.owner;history.rememberName(owner,owner==='0a664193-f099-408b-ad91-f7fc39fa98e2'?'Member A':owner==='46b19322-b0f9-490c-ad90-47989799fd74'?'Member B':member.name);
if(!accountRoute&&(path==='/html'||path.startsWith('/html/')))return htmlLibrary(req,res,url,member);
if(!accountRoute&&(path==='/skills'||path.startsWith('/skills/')))return skillLibrary(req,res,url,member);
if(!accountRoute&&(path==='/knowledge'||path.startsWith('/knowledge/')))return knowledgeLibrary(req,res,url,member);
if(!accountRoute&&(path==='/hardware'||path.startsWith('/hardware/')))return hardware(req,res,url,member);
if(!accountRoute&&path==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end(await readFile(process.env.TOOLS_HOME||'/opt/fgb-tools/web/static/home.html'))}
if(!accountRoute)return json(res,404,{error:'页面不存在'});
if(path==='/api/me'&&req.method==='GET')return json(res,200,{name:member.name,isAdmin:isAdmin(owner)});
if(path.startsWith('/api/admin/')||path==='/api/access'){if(!isAdmin(owner))return json(res,403,{error:'仅管理员可以管理权限'});
 const roster=await central('/v2/projects/members',{cookie:member.cookie,token:member.token,body:{project_id:'69197d56-41b0-4c8b-ac19-181f63e87c1f'}});
 let members=roster.ok?(roster.data?.members||roster.data?.body?.members):null;
 if(!Array.isArray(members)){try{members=JSON.parse(await readFile(new URL('./members.json',import.meta.url))).members}catch{return json(res,503,{error:'成员目录暂时不可用，请稍后重试'})}}
 if(path==='/api/admin/members'&&req.method==='GET')return json(res,200,{members:members.map(m=>({actorId:m.actor_id,name:m.actor_id==='0a664193-f099-408b-ad91-f7fc39fa98e2'?'Member A':m.actor_id==='46b19322-b0f9-490c-ad90-47989799fd74'?'Member B':m.display_name,isAdmin:isAdmin(m.actor_id),...access.visibility(m.actor_id),groupCount:access.personSnapshot(owner,m.actor_id,members).groupIds.length,accountCount:access.personSnapshot(owner,m.actor_id,members).accountIds.length}))});
 if(path==='/api/admin/members/access'&&req.method==='GET'){try{return json(res,200,access.personSnapshot(owner,url.searchParams.get('actorId'),members))}catch(e){return json(res,e.status||500,{error:e.message})}}
 if(path==='/api/access'&&req.method==='GET'){try{return json(res,200,access.snapshot(owner,url.searchParams.get('id')))}catch(e){return json(res,e.status||500,{error:e.status?e.message:'权限暂时不可用'})}}
 if(req.method==='POST'){let b;try{b=JSON.parse(await body(req))}catch{return json(res,400,{error:'请求格式无效'})}try{if(path==='/api/admin/members/access')return json(res,200,access.setPerson(owner,b,members));if(path==='/api/access')return json(res,200,access.set(owner,b,members));if(path==='/api/admin/members/visibility')return json(res,200,access.setVisibility(owner,b,members))}catch(e){return json(res,e.status||500,{error:e.status?e.message:'权限保存失败'})}}
 return json(res,404,{error:'接口不存在'});
}
if(req.method==='POST'&&path.startsWith('/api/')&&path!=='/api/accounts/reveal'&&path!=='/api/accounts'&&path!=='/api/accounts/copy'&&!isAdmin(owner))return json(res,403,{error:'仅管理员可以修改账号'});
if(path==='/api/projects'&&req.method==='GET')return json(res,200,{items:vault.projects(owner)});
if(path==='/api/projects'&&req.method==='POST'){let b;try{b=JSON.parse(await body(req))}catch{return json(res,400,{error:'请求格式无效'})}try{return json(res,200,{item:vault.createProject(owner,b)})}catch(e){return json(res,e.status||500,{error:e.status?e.message:'创建暂时不可用'})}}
if(path==='/api/projects/delete'&&req.method==='POST'){let b;try{b=JSON.parse(await body(req))}catch{return json(res,400,{error:'请求格式无效'})}try{const result=vault.deleteProject(owner,b.id);return json(res,200,{...result,groups:vault.projects(owner),items:vault.list(owner)})}catch(e){return json(res,e.status||500,{error:e.status?e.message:'删除分组暂时不可用'})}}
if(path==='/note'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end(await readFile(resolve(root,'note.html')))}
if(path==='/api/accounts/notes'&&req.method==='GET'){try{return json(res,200,vault.notes(owner,url.searchParams.get('id'),url.searchParams.get('revision')))}catch(e){return json(res,e.status||500,{error:e.status?e.message:'备注暂时无法查看'})}}
if(path==='/api/accounts/history'&&req.method==='GET'){try{return json(res,200,vault.history(owner,url.searchParams.get('id'),url.searchParams.get('before')))}catch(e){return json(res,e.status||500,{error:e.status?e.message:'历史记录暂时不可用'})}}
if(path==='/api/accounts/copy'&&req.method==='POST'){let b;try{b=JSON.parse(await body(req))}catch{return json(res,400,{error:'请求格式无效'})}try{return json(res,200,vault.copy(owner,b))}catch(e){return json(res,e.status||500,{error:e.status?e.message:'复制记录暂时不可用'})}}
if(path==='/api/accounts/reveal'&&req.method==='POST'){let b;try{b=JSON.parse(await body(req))}catch{return json(res,400,{error:'请求格式无效'})}try{return json(res,200,vault.reveal(owner,b))}catch(e){return json(res,e.status||500,{error:e.status?e.message:'密码暂时无法查看'})}}
if(path==='/api/accounts'&&req.method==='GET')return json(res,200,{items:vault.list(owner)});
if(path==='/api/accounts'&&req.method==='POST'){let b;try{b=JSON.parse(await body(req))}catch{return json(res,400,{error:'请求格式无效'})}try{return json(res,200,{item:vault.save(owner,b)})}catch(e){return json(res,e.status||500,{error:e.status?e.message:'保存暂时不可用'})}}
if(path.startsWith('/api/xianyu/')||path==='/api/records'||path==='/api/integrations')return json(res,410,{error:'当前仅开放账号凭据管理，其他功能已暂停'});
if(path.startsWith('/api/'))return json(res,404,{error:'接口不存在'});
if(req.method!=='GET'&&req.method!=='HEAD')return json(res,405,{error:'方法不支持'});
let file=resolve(root,'.'+decodeURIComponent(path));if(!file.startsWith(root+'/')&&file!==root)return json(res,403,{error:'无效路径'});try{if((await stat(file)).isDirectory())file=resolve(file,'index.html');await stat(file)}catch{file=resolve(root,'index.html')}const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png'}[extname(file)]||'application/octet-stream';res.writeHead(200,{'Content-Type':mime,'Cache-Control':file.includes('/assets/')?'private, max-age=31536000, immutable':'no-store'});res.end(req.method==='HEAD'?undefined:await readFile(file))}
const server=http.createServer((req,res)=>handler(req,res).catch(()=>{if(!res.headersSent)json(res,500,{error:'服务暂时不可用'});else res.end()}));server.listen(Number(process.env.PORT||3080),'127.0.0.1',()=>console.log('Xianyu service listening on loopback'));process.on('SIGTERM',()=>server.close(()=>{db.close();process.exit(0)}));

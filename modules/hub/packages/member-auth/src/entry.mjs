import {infrastructureFailure,domainErrorCode} from '../../platform/src/failure-contract.mjs';
import { registerVerifiedMember,registerOTPMember,SCOPES } from './provider.mjs';
import { readFile } from 'node:fs/promises';
import{createHash}from'node:crypto';
/** Install on Hufu Fastify. Auth form requests retain RFC token encoding. */
export async function installStandardEntry(app,member){
 app.addHook('onReady',member.assertPolicy);
 app.addContentTypeParser('application/x-www-form-urlencoded',{parseAs:'string'},(_request,body,done)=>done(null,body));
 app.get('/.well-known/oauth-authorization-server/v2/auth',async(request,reply)=>forward(await member.metadata(new Request(new URL('/.well-known/oauth-authorization-server'+member.prefix+'/v2/auth',member.baseURL))),reply));
 app.get('/.well-known/oauth-protected-resource/mcp',async()=>({resource:member.resource,authorization_servers:[member.issuer],scopes_supported:SCOPES,bearer_methods_supported:['header']}));
 app.get('/member/login',async(_request,reply)=>reply.type('text/html').send(page('成员登录',member.prefix)));
 app.get('/member/bootstrap',async(_request,reply)=>reply.type('text/html').send(page('确认当前成员',member.prefix)));
 app.get('/member/consent',async(request,reply)=>{const query=new URL(request.url,member.baseURL).searchParams.toString();if(!await member.verifyQuery(query))return reply.code(400).send({error:'invalid_oauth_signature'});return reply.type('text/html').send(page('授权客户端',member.prefix));});
 app.get('/member/client.js',async(_request,reply)=>reply.type('text/javascript').send(await readFile(new URL('../public/client.js',import.meta.url))));
 app.get('/member/software.js',async(_request,reply)=>reply.header('cache-control','no-store').type('text/javascript').send(await readFile(new URL('../public/software.js',import.meta.url))));
 app.get('/v2/member/software',{logLevel:'silent'},async(request,reply)=>{
  let token=request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if(!token){const headers=new Headers();if(request.headers.cookie)headers.set('cookie',request.headers.cookie);const session=await member.auth.api.getSession({headers});token=session?.session?.token;}
  if(!token)return reply.code(401).send({error:'current_primary_member_session_required'});
  try{const result=(await member.pool.query('SELECT authz.member_software_view($1) AS result',[createHash('sha256').update(token).digest('hex')])).rows[0].result;return reply.header('cache-control','no-store').send(result);}
  catch(e){const failure=infrastructureFailure(e);if(failure?.status===401||failure?.status===403)return reply.code(failure.status).send({error:'current_primary_member_session_required',error_code:failure.code});throw e;}
 });
 const registration=register=>async(request,reply)=>{
  const token=request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if(!token)return reply.code(401).send({state:'failed',error_code:'unauthenticated'});
  try{return await register(member,token,request.body);}
  catch(e){
   // Better Auth APIError is a protocol error, not a raw SQL/domain exception.
   if(Number.isInteger(e.statusCode)&&e.statusCode>=400&&e.statusCode<=599&&e.body?.code){
    return reply.code(e.statusCode).send({state:'failed',error_code:domainErrorCode(e.body.code,'member_registration_failed'),message:e.body.message,...(e.statusCode===503?{retained_state:'query_existing_member_registration',next_step:'retry_with_same_member_and_email'}:{})});
   }
   throw e;
  }
 };
 app.post('/v2/member/register-otp',{logLevel:'silent'},registration(registerOTPMember));
 app.post('/v2/member/register',{logLevel:'silent'},registration(registerVerifiedMember));
}
export async function forward(response,reply){reply.code(response.status);response.headers.forEach((value,key)=>{if(key!=='set-cookie')reply.header(key,value);});const cookies=response.headers.getSetCookie();if(cookies.length)reply.header('set-cookie',cookies);return reply.send(await response.text());}
export function authRequest(request,baseURL){const headers=new Headers();for(const[k,v]of Object.entries(request.headers))if(v!==undefined)headers.set(k,Array.isArray(v)?v.join(','):v);let body;if(!['GET','HEAD'].includes(request.method))body=typeof request.body==='string'?request.body:JSON.stringify(request.body);return new Request(new URL(new URL(baseURL).pathname.replace(/\/$/,'')+request.url,baseURL),{method:request.method,headers,...(body===undefined?{}:{body})});}
function page(title,prefix){return`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{font:16px system-ui;max-width:38rem;margin:3rem auto;padding:1rem}label{display:block;margin:1rem 0}input,button{font:inherit;padding:.6rem}input{width:90%}button{margin:.4rem}output{display:block;white-space:pre-wrap}</style><body data-entry-prefix="${prefix}"><h1>${title}</h1><p>使用组织成员邮箱接收验证码，客户端按你的当前工作资格访问。</p><form id="otp-login"><label>成员邮箱<input name="email" type="email" required autocomplete="username"></label><button id="otp-send" type="button">发送验证码</button><label>邮箱验证码<input name="otp" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autocomplete="one-time-code"></label><button>登录</button></form><p>验证码 5 分钟内有效，登录后可以继续客户端工作。</p><details><summary>微信与 Passkey（可选）</summary><button id="wechat">微信扫码登录</button><p>首次关联微信请使用主控提供的当前成员引导链接。</p><button id="wechat-bind">关联当前成员的微信</button><button id="passkey">使用 Passkey 登录</button><button id="enroll">注册此设备 Passkey</button></details><section id="consent" hidden><p id="request"></p><button id="accept">允许访问</button><button id="deny">拒绝</button></section><details><summary>首次绑定本人邮箱</summary><p>如果尚未登记邮箱，可用已有的本人主凭据绑定；不会建立新身份，也不需要设置密码。</p><form id="member-register-otp"><label>显示名称<input name="name" required maxlength="200" autocomplete="name"></label><label>本人邮箱<input name="email" type="email" required autocomplete="email"></label><label>已有本人主凭据<input name="primary" type="password" required autocomplete="off"></label><button>绑定邮箱并发送验证码</button></form></details><section id="software" hidden><h2>我的软件接入</h2><p>登录后为自己的 MCP 或 App 取得凭据。只选择该软件需要的项目与能力，直到撤销；它不会获得新项目资格。</p><form id="software-create"><label>软件名称<input name="label" required maxlength="200" placeholder="例如：我的桌面 Agent"></label><label>能力<select name="mode"><option value="read">只读资料与工作</option><option value="work">读取与工作</option></select></label><fieldset><legend>允许访问的当前项目</legend><div id="software-projects"></div></fieldset><button>创建软件凭据</button></form><output id="software-status" aria-live="polite"></output><textarea id="software-result" hidden readonly rows="10" aria-label="本人新软件MCP配置"></textarea><button id="software-copy" hidden type="button">复制 MCP 配置</button><button id="software-download" hidden type="button">保存配置文件</button><h3>已有普通软件</h3><div id="software-list"></div><button id="software-refresh" type="button">刷新</button></section>
<output id="result" aria-live="polite"></output><script src="${prefix}/member/client.js" defer></script><script src="${prefix}/member/software.js" defer></script></html>`;}

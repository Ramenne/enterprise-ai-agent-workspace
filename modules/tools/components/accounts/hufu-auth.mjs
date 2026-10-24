import {randomBytes,createHash,createCipheriv,createDecipheriv,hkdfSync} from 'node:crypto';
const base='https://hufu.example.invalid/hub2-preview/hufu';
const limits=new Map(),maxDuration=365*24*3600000;
let database;
export function configureSessions(db){database=db;db.exec('CREATE TABLE IF NOT EXISTS hufu_sessions(token_hash TEXT PRIMARY KEY, actor TEXT NOT NULL, secret TEXT NOT NULL, expires_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS hufu_sessions_expiry ON hufu_sessions(expires_at)');}
const hash=token=>createHash('sha256').update(token).digest('hex');
const key=()=>{const k=Buffer.from(process.env.XIANYU_KEY||'','base64');if(k.length!==32)throw Error('登录持久化尚未配置');return hkdfSync('sha256',k,Buffer.alloc(0),'xianyu-hufu-session-v1',32)};
function seal(cookie){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key(),iv),bytes=Buffer.concat([c.update(cookie,'utf8'),c.final()]);return Buffer.concat([iv,bytes,c.getAuthTag()]).toString('base64')}
function unseal(secret){const b=Buffer.from(secret,'base64'),c=createDecipheriv('aes-256-gcm',key(),b.subarray(0,12));c.setAuthTag(b.subarray(-16));return Buffer.concat([c.update(b.subarray(12,-16)),c.final()]).toString('utf8')}
function merge(cookie,updates=[]){const values=new Map(cookie.split(';').map(s=>s.trim()).filter(Boolean).map(s=>{const i=s.indexOf('=');return [s.slice(0,i),s.slice(i+1)]}));for(const line of updates){const pair=line.split(';')[0],i=pair.indexOf('=');if(i<1)continue;const name=pair.slice(0,i);if(/max-age=0(?:;|$)/i.test(line))values.delete(name);else values.set(name,pair.slice(i+1))}return [...values].map(([k,v])=>k+'='+v).join('; ')}
function expiration(response,fallback){const stamp=response?.data?.session?.expiresAt;if(stamp){const n=Date.parse(stamp);if(Number.isFinite(n))return Math.min(Date.now()+maxDuration,n)}for(const cookie of response?.updates||[]){if(!/session[_-]token=/i.test(cookie))continue;const age=cookie.match(/max-age=(\d+)/i),exp=cookie.match(/expires=([^;]+)/i);if(age)return Math.min(Date.now()+maxDuration,Date.now()+Number(age[1])*1000);if(exp&&Number.isFinite(Date.parse(exp[1])))return Math.min(Date.now()+maxDuration,Date.parse(exp[1]))}return fallback}
const reqToken=req=>(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('tools_session='))?.slice(14);
export function allow(ip){const now=Date.now(),v=limits.get(ip);if(v&&now<v.until&&v.n>=15)return false;limits.set(ip,{n:v&&now<v.until?v.n+1:1,until:v&&now<v.until?v.until:now+900000});return true;}
export async function central(path,{cookie,token,body,idempotencyKey}={}){const r=await fetch(base+path,{method:body?'POST':'GET',headers:{Accept:'application/json',...(body?{'Content-Type':'application/json',Origin:'https://hufu.example.invalid/'}:{}),...(cookie?{Cookie:cookie}:{}),...(token?{Authorization:'Bearer '+token}:{}),...(idempotencyKey?{'Idempotency-Key':idempotencyKey}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000),redirect:'error'});let data;try{data=await r.json()}catch{data=null}const updates=r.headers.getSetCookie();return {ok:r.ok,status:r.status,data,updates,cookies:merge('',updates)};}
const forever=Number.MAX_SAFE_INTEGER;
const unavailable=()=>Object.assign(Error('身份权限服务暂时不可用，请稍后重试'),{status:503});
async function inspect(payload,actor){
 const r=await central('/v2/me',{token:payload.token});
 if([401,403].includes(r.status))return null;if(!r.ok)throw unavailable();
 const id=r.data;if(id?.actor_id!==actor||id.principal_kind!=='member'||id.credential_type!=='member_api'||id.credential_id!==payload.credentialId||id.until_revoked!==true)return null;
 return {owner:actor,name:id.member_label||'成员',token:payload.token};
}
async function remember(native,actor,operation){
 const primary=await central('/v2/me',{token:native.session.token});
 if(!primary.ok||primary.data?.actor_id!==actor||primary.data?.principal_kind!=='member'||primary.data?.is_primary!==true)throw unavailable();
 // Read-only access follows this member's current central qualification.
 const r=await central('/v2/credentials/create',{token:native.session.token,idempotencyKey:'tools-remember-'+operation,body:{label:'协作平台工具合集长期登录',actions:['mem.read','v8.project.read'],until_revoked:true,expires_at:null}});
 if(!r.ok||typeof r.data?.credential!=='string'||typeof r.data?.credential_id!=='string')throw unavailable();
 const payload={kind:'tools_remembered',token:r.data.credential,credentialId:r.data.credential_id};
 if(!await inspect(payload,actor))throw unavailable();return payload;
}
export async function signin(email,otp){
 const r=await central('/v2/auth/sign-in/email-otp',{body:{email,otp}});if(!r.ok||!r.cookies)return null;
 const me=await central('/portal/api/me',{cookie:r.cookies});if(!me.ok||!me.data?.identity?.actor_id||me.data.identity.principal_kind!=='member')return null;
 const cookie=merge(r.cookies,me.updates),native=await central('/v2/auth/get-session',{cookie});
 if(!native.ok||!native.data?.session?.token||Date.parse(native.data.session.expiresAt)<=Date.now())return null;
 const actor=me.data.identity.actor_id,token=randomBytes(32).toString('base64url'),h=hash(token),payload=await remember(native.data,actor,h);
 database.prepare('DELETE FROM hufu_sessions WHERE expires_at<=?').run(Date.now());database.prepare('INSERT INTO hufu_sessions VALUES(?,?,?,?)').run(h,actor,seal(JSON.stringify(payload)),forever);
 return {token,maxAge:Math.floor(maxDuration/1000)};
}
export async function authenticate(req,res){
 const token=reqToken(req);if(!token||! /^[A-Za-z0-9_-]{43}$/.test(token))return null;
 const h=hash(token),s=database.prepare('SELECT * FROM hufu_sessions WHERE token_hash=?').get(h);if(!s)return null;
 const drop=()=>{database.prepare('DELETE FROM hufu_sessions WHERE token_hash=?').run(h);return null};
 if(s.expires_at<=Date.now())return drop();let clear;try{clear=unseal(s.secret)}catch{return drop()}
 let payload;try{payload=JSON.parse(clear)}catch{}
 if(payload?.kind!=='tools_remembered'){
  // Existing live browser logins upgrade via their own primary member session.
  // Expired central sessions cannot bootstrap a new remembered credential.
  const native=await central('/v2/auth/get-session',{cookie:clear});
  if([401,403].includes(native.status)||(native.ok&&!native.data?.session))return drop();if(!native.ok)throw unavailable();
  if(!native.data?.session?.token||Date.parse(native.data.session.expiresAt)<=Date.now())return drop();
  const me=await central('/portal/api/me',{cookie:merge(clear,native.updates)});
  if([401,403].includes(me.status))return drop();if(!me.ok)throw unavailable();
  if(me.data?.identity?.principal_kind!=='member'||me.data.identity.actor_id!==s.actor)return drop();
  payload=await remember(native.data,s.actor,h);database.prepare('UPDATE hufu_sessions SET secret=?,expires_at=? WHERE token_hash=?').run(seal(JSON.stringify(payload)),forever,h);
 }
 const member=await inspect(payload,s.actor);if(!member)return drop();if(res)res.setHeader('Set-Cookie',sessionCookie(token,Date.now()+maxDuration));return member;
}
export function sessionCookie(token,until){return `tools_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.max(1,Math.floor(Math.min(maxDuration,until-Date.now())/1000))}`;}
export async function logout(req){
 const token=reqToken(req);if(!token)return;const h=hash(token),row=database.prepare('SELECT secret FROM hufu_sessions WHERE token_hash=?').get(h);if(!row)return;
 let payload;try{payload=JSON.parse(unseal(row.secret))}catch{}
 if(payload?.kind==='tools_remembered'){
  const r=await central('/v2/credentials/revoke',{token:payload.token,idempotencyKey:'tools-remember-logout-'+payload.credentialId,body:{credential_id:payload.credentialId}});
  if(!r.ok&&![401,403,404].includes(r.status))throw unavailable();
 }
 database.prepare('DELETE FROM hufu_sessions WHERE token_hash=?').run(h);
}

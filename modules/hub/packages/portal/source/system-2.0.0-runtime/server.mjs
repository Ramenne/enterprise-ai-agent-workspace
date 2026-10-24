import{projectStatus}from'./portal-status.mjs';
import{createApplicationSso,applicationSsoTargets}from'./application-sso.mjs';
import{cachedFile,conditional}from'./file-cache.mjs';
import{portalSession}from'./portal-session.mjs';
import{createMaterialWorkspace}from'./material-workspace-api.mjs';
import{Readable}from'node:stream';
import http from 'node:http';
import {randomBytes,timingSafeEqual,createHmac} from 'node:crypto';
import {readFile} from 'node:fs/promises';
const CENTRAL='https://hufu.example.invalid/',PREFIX='/hub2-preview/hufu',BASE=PREFIX+'/portal';
const HOSTS={
 'service.example.invalid':'home','service.example.invalid':'home',
 'service.example.invalid':'mem','service.example.invalid':'mem',
 'service.example.invalid':'v8','service.example.invalid':'v8',
 'service.example.invalid':'wiki','service.example.invalid':'git','service.example.invalid':'git',
};
const TARGETS={baize_hufu2:'https://baize.example.invalid/',tools_hufu2:'https://tools.example.invalid/',mem:'https://mengchu.example.invalid/',v8:'https://kanban.example.invalid/',wiki:'https://wiki.example.invalid/',git:'https://git.example.invalid/',baize:'https://baize.example.invalid/'};
const handoffSession=portalSession(Buffer.from((await readFile(new URL('./portal-session-key.private',import.meta.url),'utf8')).trim(),'hex'));
const browserCacheSalt=randomBytes(32);
const cachePartition=me=>createHmac('sha256',browserCacheSalt).update(JSON.stringify([me.token,me.id.actor_id,me.id.client_id,me.id.credential_id,me.id.client_actions,me.id.scope_filters,me.id.member_profile?.current_role])).digest('hex').slice(0,32);
const tickets=new Map(),sessions=new Map(),pageCredentials=new Map(),documentationCredentials=new Map();
const secret=JSON.parse(await readFile(new URL('./consumers.private.json',import.meta.url),'utf8'));
const applicationSso=createApplicationSso({handoffSession,identity,tickets,consumers:secret,call});
const random=()=>randomBytes(32).toString('base64url');
const cookie=(name,value,max=28800)=>`${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${max}`;
const cookies=req=>Object.fromEntries((req.headers.cookie||'').split(';').map(s=>s.trim().split(/=(.*)/s)).filter(x=>x.length>1));
function respond(res,status,body,headers={}){res.writeHead(status,{'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff',...headers});res.end(typeof body==='string'?body:JSON.stringify(body));}
const json=(res,b,status=200)=>respond(res,status,b,{'content-type':'application/json; charset=utf-8'});
const redirect=(res,url,headers={})=>respond(res,302,'',{'location':url,...headers});
async function body(req){let s='';for await(const chunk of req){s+=chunk;if(s.length>12*1024*1024)throw Object.assign(Error('request_too_large'),{status:413});}try{return JSON.parse(s||'{}');}catch{throw Object.assign(Error('invalid_json'),{status:400});}}
async function call(url,options={}){const r=await fetch(url,{...options,signal:AbortSignal.timeout(30000)});let b;try{b=await r.json();}catch{b={error:'upstream_unavailable'};}if(!r.ok)throw Object.assign(Error(b.message||b.error_code||b.error||'upstream_unavailable'),{status:r.status});return b;}
async function identity(rawCookie){
 if(!rawCookie)return null;
 const s=await call('http://127.0.0.1:4611/v2/auth/get-session',{headers:{cookie:rawCookie}});
 if(!s?.session?.token||new Date(s.session.expiresAt)<=new Date())return null;
 const id=await call('http://127.0.0.1:4611/v2/me',{headers:{authorization:'Bearer '+s.session.token}});
 return {cookie:rawCookie,token:s.session.token,id,user:{name:id.member_label,email:s.user.email},expires:new Date(s.session.expiresAt).getTime()};
}
async function current(req,host){
 if(host==='service.example.invalid')return identity(req.headers.cookie).catch(e=>{if(e.status===401)return null;throw e;});
 const key=cookies(req)['__Host-hub_portal'],s=sessions.get(key)||handoffSession.open(key);if(!s||s.host!==host||s.expires<Date.now())return null;
 const me=await identity(s.cookie).catch(e=>{if(e.status===401||e.status===403)return null;throw e;});if(!me){sessions.delete(key);return null;}return me;
}
function targetStart(req,res,host,next='/'){
 const state=random();const service=HOSTS[host];const target=Object.entries(TARGETS).find(([id,url])=>id===service)?.[0];
 if(!target&&service==='home')return redirect(res,CENTRAL+BASE);
 const params=new URLSearchParams({target,state,host,next:next.startsWith('/')&&!next.startsWith('//')?next:'/'});
 redirect(res,CENTRAL+BASE+'/sso/start?'+params,{'set-cookie':cookie('__Host-hub_state',state,120)});
}
const allowed=new Set(['mengchu_search','mengchu_get','mengchu_upload','v8.project.search','mem.enumerate','mem.enumerate.page','hub.material.attributes','hub.material.usage','hub.material.govern','mem.read_full','mem.material.history','mem.description.read','mem.description.save','mem.semantic.index_fixed','mem.semantic.query','hub.document.save']);
async function pageToken(me){
 const previous=pageCredentials.get(me.token);if(previous&&previous.expires>Date.now()+30000)return previous.token;
 const expires=Math.min(me.expires,Date.now()+2*3600000);
 const grant=await call('http://127.0.0.1:4611/v2/credentials/create',{method:'POST',headers:{authorization:'Bearer '+me.token,'content-type':'application/json','idempotency-key':'portal-page-'+random()},body:JSON.stringify({label:'浏览器资料工作台',actions:['mem.read','mem.upload','mem.write','mem.process','mem.correct','v8.project.create','v8.project.read','v8.work.read'],expires_at:new Date(expires).toISOString(),until_revoked:false})});
 if(typeof grant.credential!=='string')throw Error('page_credential_unavailable');pageCredentials.set(me.token,{token:grant.credential,expires});return grant.credential;
}
async function rpc(token,name,args){if(!allowed.has(name))throw Object.assign(Error('tool_not_exposed_in_page'),{status:403});
 const r=await fetch('http://127.0.0.1:8939/mcp',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:random(),method:'tools/call',params:{name,arguments:args}}),signal:AbortSignal.timeout(120000)});
 const txt=await r.text();let b;try{b=JSON.parse(txt);}catch{const line=txt.split('\n').filter(x=>x.startsWith('data:')).at(-1);b=line?JSON.parse(line.slice(5)):{};}
 if(!r.ok||b.error)throw Object.assign(Error(b.error?.message||'mcp_call_failed'),{status:r.ok?400:r.status});const out=b.result;if(out?.isError){const d=out.structuredContent||JSON.parse(out.content?.find(x=>x.type==='text')?.text||'{}');throw Object.assign(Error(d.error_code||d.state||'operation_failed'),{status:d.error_code==='forbidden'?403:d.error_code==='unauthenticated'?401:400,detail:d.detail||d});}
 return out?.structuredContent??JSON.parse(out?.content?.find(x=>x.type==='text')?.text||'{}');
}
async function documentationText(me,entry,manifest){
 const file=await cachedFile(new URL('./docs/'+(manifest.release_directory?manifest.release_directory+'/':'')+entry.filename,import.meta.url));
 return{text:file.text,source:'official_published_manual_cache',source_version:entry.fixed_ref,edition:manifest.version,system_version:manifest.system_version??null};
}

async function status(me,refresh=false){return projectStatus(me.token,call,refresh);}
const v8Paths={projects:'/v2/projects/search',works:'/v2/work-items/search',read:'/v2/work-items/read',create_project:'/v2/projects',open_work:'/v2/work-items/open',save_work:'/v2/work-items/save',fields:'/v2/governance/fields'};
const materialWorkspace=createMaterialWorkspace({rpc,pageToken,call});
const srv=http.createServer(async(req,res)=>{try{
 const host=(req.headers.host||'').split(':')[0].toLowerCase(),url=new URL(req.url,'https://'+host);if(!HOSTS[host])return json(res,{error:'unknown_service_host'},421);
 let path=url.pathname.startsWith(BASE)?url.pathname.slice(BASE.length)||'/':url.pathname.replace(/^\/portal/,'')||'/';
 if(path==='/health')return json(res,{state:'online',service:'hub2-member-portal'});
 if(path==='/codex-instructions-reference.png'&&req.method==='GET'){
  const file=await cachedFile(new URL('./public/codex-instructions-reference.png',import.meta.url));return conditional(req,res,file.bytes,{type:'image/png',cache:'public, max-age=3600',vary:''});
 }
 const publicDocs={'/secret-delivery-guide.md':'secret-delivery-guide.md','/start-guide.md':'start-guide.md','/agent-preset.md':'agent-preset.md','/starter-prompt.md':'starter-prompt.md'};
 if(publicDocs[path]&&req.method==='GET'){const manifest=JSON.parse((await cachedFile(new URL('./docs/manifest.json',import.meta.url))).text);const filename=publicDocs[path],directory=manifest.release_directory&&manifest.documents.some(d=>d.filename===filename)?manifest.release_directory+'/':'';return conditional(req,res,(await cachedFile(new URL('./docs/'+directory+filename,import.meta.url))).bytes,{type:'text/markdown; charset=utf-8',cache:'public, max-age=0, must-revalidate',vary:''});}
 if(['/cache.js','/app.js','/style.css','/library.js','/library.css','/credentials.js','/credentials.css'].includes(path)){const f=path.slice(1);return conditional(req,res,(await cachedFile(new URL('./public/'+f,import.meta.url))).bytes,{type:f.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8',cache:'public, max-age=3600',vary:''});}
 if(path==='/api/application-sso/check'&&req.method==='POST')return json(res,await applicationSso.check(req,await body(req),timingSafeEqual));
 if(path==='/api/sso/exchange'&&req.method==='POST'){
  const b=await body(req);if(applicationSsoTargets[b.target])return json(res,await applicationSso.exchange(req,b,timingSafeEqual));const supplied=req.headers['x-hub-consumer-key']||'',known=secret[b.target]||'';
  if(!known||supplied.length!==known.length||!timingSafeEqual(Buffer.from(supplied),Buffer.from(known)))return json(res,{error:'consumer_not_authorized'},403);
  const t=tickets.get(b.ticket);if(!t||t.target!==b.target||t.state!==b.state||t.expires<Date.now())return json(res,{error:'invalid_handoff'},401);tickets.delete(b.ticket);const me=await identity(t.cookie);if(!me)return json(res,{error:'session_expired'},401);
  return json(res,{identity:me.id,user:me.user,token:me.token,expires_at:new Date(me.expires).toISOString()});
 }
 if(path==='/sso/callback'){
  const t=tickets.get(url.searchParams.get('ticket'));if(!t||t.host!==host||t.state!==cookies(req)['__Host-hub_state']||t.expires<Date.now())return json(res,{error:'invalid_handoff'},401);tickets.delete(url.searchParams.get('ticket'));
  if(!await identity(t.cookie))return targetStart(req,res,host);
  const key=handoffSession.seal({cookie:t.cookie,host,expires:t.sessionExpires});return redirect(res,t.next,{'set-cookie':[cookie('__Host-hub_portal',key),cookie('__Host-hub_state','',0)]});
 }
 let me;
 const documentationToken=path.startsWith('/api/docs')&&req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
 if(documentationToken){const id=await call('http://127.0.0.1:4611/v2/me',{headers:{authorization:'Bearer '+documentationToken}});me={id,token:documentationToken};}
 else me=await current(req,host);
 if(path==='/start'&&me&&HOSTS[host]==='git')return redirect(res,'/');
 if(path==='/sso/start'){
  if(host!=='service.example.invalid')return json(res,{error:'central_login_required'},400);
  const target=url.searchParams.get('target'),state=url.searchParams.get('state'),targetHost=url.searchParams.get('host')||new URL(TARGETS[target]||CENTRAL).host;
  if(!TARGETS[target]||!state||!/^[-\w]{32,100}$/.test(state)||!(HOSTS[targetHost]===target||target==='baize'&&targetHost==='service.example.invalid'||applicationSsoTargets[target]?.host===targetHost))return json(res,{error:'invalid_target'},400);
  if(me){const code=random(),next=url.searchParams.get('next')||'/';tickets.set(code,{target,host:targetHost,state,cookie:me.cookie,expires:Date.now()+60000,sessionExpires:me.expires,next:next.startsWith('/')&&!next.startsWith('//')?next:'/'});const cb=applicationSsoTargets[target]?.callback||(target==='baize'?'/hub-sso/callback':'/portal/sso/callback');return redirect(res,'https://'+targetHost+cb+'?'+new URLSearchParams({ticket:code,state}));}
 }
 if(!me&&path==='/api/auth-check')return respond(res,401,'');
 if(!me&&path.startsWith('/api/'))return json(res,{error:'login_required'},401);
 if(!me&&host!=='service.example.invalid')return targetStart(req,res,host,path==='/start'?'/' : req.headers['x-original-uri']||url.pathname+url.search);
 if(path.startsWith('/api/')){
  if(!me)return json(res,{error:'login_required'},401);
  if(req.method!=='GET'&&req.headers.origin!=='https://'+host)return json(res,{error:'same_origin_required'},403);
  if(path.startsWith('/api/vault-delivery/download/')&&req.method==='GET'){
   const id=path.split('/').at(-1);if(!/^[-a-f0-9]{36}$/.test(id))return json(res,{error:'invalid_input'},400);
   const upstream=await fetch('http://127.0.0.1:4611/v2/vault/deliveries/download/'+id,{headers:{authorization:'Bearer '+me.token},signal:AbortSignal.timeout(15000)});
   if(!upstream.ok){const b=await upstream.json();return json(res,b,upstream.status);}
   res.writeHead(200,{'content-type':'application/octet-stream','cache-control':'no-store','referrer-policy':'no-referrer','content-disposition':upstream.headers.get('content-disposition'),'x-hufu-delivery-receipt':upstream.headers.get('x-hufu-delivery-receipt')});
   const stream=Readable.fromWeb(upstream.body);res.on('close',()=>stream.destroy());stream.on('error',()=>res.destroy());return stream.pipe(res);
  }
  if(path.startsWith('/api/vault-delivery/')&&req.method==='POST'){
   const op=path.split('/').at(-1);if(!['list','recipients','register','challenge','verify','apply','applications','candidates','decide'].includes(op))return json(res,{error:'not_found'},404);
   return json(res,await call('http://127.0.0.1:4611/v2/vault/deliveries/'+op,{method:'POST',headers:{authorization:'Bearer '+me.token,'content-type':'application/json'},body:JSON.stringify(await body(req))}));
  }
  if(path==='/api/me')return json(res,{user:me.user,identity:me.id,service:HOSTS[host],cache_partition:cachePartition(me)});
 if(path==='/api/releases/updates'&&req.method==='GET')return json(res,await call('http://127.0.0.1:4611/v2/releases/updates',{headers:{authorization:'Bearer '+me.token}}));
  if(path==='/api/docs'&&req.method==='GET')return conditional(req,res,JSON.parse((await cachedFile(new URL('./docs/manifest.json',import.meta.url))).text));
  if(path.startsWith('/api/docs/')&&req.method==='GET'){
   const manifest=JSON.parse((await cachedFile(new URL('./docs/manifest.json',import.meta.url))).text);const entry=manifest.documents.find(x=>x.id===path.slice('/api/docs/'.length));if(!entry)return json(res,{error:'document_not_found'},404);
   return conditional(req,res,{...entry,...await documentationText(me,entry,manifest)});
  }
  if(path==='/api/onboarding/prepare'&&req.method==='POST'){
   const headers={authorization:'Bearer '+me.token,'content-type':'application/json'};
   const found=await call('http://127.0.0.1:4613/v2/projects/search',{method:'POST',headers,body:JSON.stringify({query:'我的个人资料',limit:100})});
   const matches=(found.items||[]).filter(p=>p.title==='我的个人资料'&&p.visibility==='personal'&&p.owner_id===me.id.actor_id);
   if(matches.length>1)return json(res,{error:'personal_project_ambiguous'},409);
   if(matches.length)return json(res,{state:'existing',project:matches[0]});
   const created=await call('http://127.0.0.1:4613/v2/projects',{method:'POST',headers:{...headers,'idempotency-key':'onboarding-personal-'+me.id.actor_id},body:JSON.stringify({title:'我的个人资料',kind:'project',visibility:'personal'})});
   return json(res,{state:'created',project:created.project});
  }
  if(path==='/api/software'&&req.method==='GET')return json(res,await call('http://127.0.0.1:4611/v2/member/software',{headers:{authorization:'Bearer '+me.token}}));
  if(path==='/api/software/create'&&req.method==='POST'){
   const b=await body(req);if(typeof b.label!=='string'||!b.label.trim()||b.label.length>200||!['read','work'].includes(b.mode)||!Array.isArray(b.project_ids)||!b.project_ids.length||b.project_ids.some(x=>typeof x!=='string'||!/^[-a-f0-9]{36}$/.test(x)))return json(res,{error:'invalid_input'},400);
   const read=['mem.read','v8.project.read','v8.work.read','v8.context.read','v8.experience.read'];const actions=b.mode==='read'?read:[...read,'mem.upload','mem.write','mem.delete','mem.share','mem.process','mem.correct','v8.work.open','v8.work.commit','v8.context.prepare','v8.context.materialize','v8.handoff.record','v8.handoff.read','v8.experience.publish','v8.experience.feedback'];
   return json(res,await call('http://127.0.0.1:4611/v2/credentials/create',{method:'POST',headers:{authorization:'Bearer '+me.token,'content-type':'application/json','idempotency-key':req.headers['idempotency-key']||random()},body:JSON.stringify({label:b.label.trim(),actions,until_revoked:true,expires_at:null,resource_selector:{version:1,kind:'projects',project_ids:b.project_ids}})}));
  }
  if(path==='/api/software/revoke'&&req.method==='POST'){
   const b=await body(req);if(typeof b.credential_id!=='string'||!/^[-a-f0-9]{36}$/.test(b.credential_id))return json(res,{error:'invalid_input'},400);
   return json(res,await call('http://127.0.0.1:4611/v2/credentials/revoke',{method:'POST',headers:{authorization:'Bearer '+me.token,'content-type':'application/json','idempotency-key':req.headers['idempotency-key']||random()},body:JSON.stringify({credential_id:b.credential_id})}));
  }
  if(path==='/api/status')return json(res,await status(me,url.searchParams.get('refresh')==='true'));
  if(path==='/api/auth-check'){const actor=me.id.actor_id;const names={'46b19322-b0f9-490c-ad90-47989799fd74':'admin'};return respond(res,200,'',{'x-hub-user':names[actor]||'hub_'+actor.replaceAll('-',''),'x-hub-email':me.user.email});}
  if(path==='/api/materials/inventory'&&req.method==='GET')return json(res,await materialWorkspace.handle(me,'inventory'));
  if(path==='/api/materials/download'&&req.method==='GET'){const d=await materialWorkspace.download(me,url.searchParams.get('material_id'),url.searchParams.get('version_id'),url.searchParams.get('name'));res.writeHead(200,{'content-type':'application/octet-stream','content-disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(d.name),'cache-control':'no-store'});const stream=Readable.fromWeb(d.response.body);res.on('close',()=>stream.destroy());stream.on('error',()=>res.destroy());return stream.pipe(res);}
  if(path.startsWith('/api/materials/')&&req.method==='POST'){const op=path.split('/').at(-1),b=await body(req);return json(res,await(op==='semantic'?materialWorkspace.semantic(me,b):materialWorkspace.handle(me,op,b)));}
  if(path==='/api/rpc'&&req.method==='POST'){const b=await body(req);return json(res,await rpc(await pageToken(me),b.name,b.arguments||{}));}
  if(path.startsWith('/api/v8/')&&req.method==='POST'){const type=path.split('/').at(-1);if(!v8Paths[type])return json(res,{error:'unknown_operation'},404);return json(res,await call('http://127.0.0.1:4613'+v8Paths[type],{method:'POST',headers:{authorization:'Bearer '+me.token,'content-type':'application/json','idempotency-key':req.headers['idempotency-key']||random()},body:JSON.stringify(await body(req))}));}
  if(path==='/api/logout'&&req.method==='POST'){await call('http://127.0.0.1:4611/v2/auth/sign-out',{method:'POST',headers:{cookie:me.cookie,origin:CENTRAL,'content-type':'application/json'},body:'{}'});for(const[k,s]of sessions)if(s.cookie===me.cookie)sessions.delete(k);pageCredentials.delete(me.token);return json(res,{state:'signed_out'});}
  return json(res,{error:'not_found'},404);
 }
 const library=HOSTS[host]==='mem'||path==='/library';let html=(await cachedFile(new URL(path==='/credentials'?'./public/credentials.html':library?'./public/library.html':'./public/index.html',import.meta.url))).text;for(const f of ['cache.js','app.js','style.css','library.js','library.css','credentials.js','credentials.css','codex-instructions-reference.png']){const asset=await cachedFile(new URL('./public/'+f,import.meta.url));html=html.replaceAll('__BASE__/'+f, '__BASE__/'+f+'?v='+asset.etag.replaceAll('\"','').slice(0,16));}html=html.replace(/(\?v=[a-f0-9]{16})\?v=[^\" ]+/g,'$1');const route=host==='service.example.invalid'?BASE:'/portal';return respond(res,200,html.replaceAll('__BASE__',route).replaceAll('__SERVICE__',HOSTS[host]),{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'"});
 }catch(e){json(res,{error:e.message||'service_unavailable',...(e.detail?{detail:e.detail}:{})},e.status||503);}});
srv.listen(Number(process.env.PORT||4616),'127.0.0.1');
setInterval(()=>{for(const [k,t]of tickets)if(t.expires<Date.now())tickets.delete(k);for(const[k,s]of sessions)if(s.expires<Date.now())sessions.delete(k);},60000).unref();

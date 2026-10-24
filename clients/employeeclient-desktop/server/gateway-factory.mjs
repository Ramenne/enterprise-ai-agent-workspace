import {resolveNativeMember,persistNativeMember,revokeNativeMember,memberDeviceCookie} from './native-member-login.mjs';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
// Use the actual native browser entry. No member MCP key or supervisor token.
const CENTRAL='https://hufu.example.invalid/';
const PORTAL='/hub2-preview/hufu/portal';
const AUTH='/hub2-preview/hufu/v2/auth';
import {TOOLS,nativeRoute} from './native-routes.mjs';
import {relayNativeUpload} from './native-upload.mjs';
export {TOOLS,nativeRoute} from './native-routes.mjs';
export function relayCookie(cookie,{crossSite=false}={}) {
  // Scope a native HttpOnly session to this app host. No JS token persistence.
  return cookie.replace(/;\s*Domain=[^;]*/gi,'').replace(/;\s*Path=[^;]*/gi,'')
    .replace(/;\s*SameSite=[^;]*/gi,'').replace(/;\s*Secure\b/gi,'').replace(/;\s*HttpOnly\b/gi,'')
    +'; Path=/; HttpOnly; Secure; SameSite='+(crossSite?'None':'Lax');
}
export function createGateway({fetcher=globalThis.fetch,publicOrigin='http://localhost:5176',nativeOrigins=[],root=resolve('dist'),businessHandler=null,persistentLoginEnabled=false}={}) {
  const allowed=new Set([new URL(publicOrigin).origin,...nativeOrigins]);
  // Upload parts may progress for longer than Node's five-minute default.
  // The relay separately enforces byte-idle and total limits.
  return createServer({requestTimeout:1800000,headersTimeout:60000},async(req,res)=>{
    const renewCookies=response=>{
      const values=response.headers.getSetCookie?.()||[];
      if(values.length&&!res.headersSent)res.setHeader('set-cookie',[
        ...[].concat(res.getHeader('set-cookie')||[]),
        ...values.map(c=>relayCookie(c,{crossSite:nativeOrigins.includes(req.headers.origin)})),
      ]);
    };
    const reply=(status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
    try {
      const path=new URL(req.url,'http://localhost').pathname;
      if(path==='/health') return reply(200,{state:'ready',component:'native-interface-candidate',chat:businessHandler?'runtime_connected':'not_connected',foundation_subscription:businessHandler?.notificationStatus?.()??{state:'not_configured'},push_delivery:businessHandler?.pushStatus?.()??{state:'not_configured'},login_acceptance:'not_asserted',device_delivery:'not_asserted'});
      if(!path.startsWith('/native/')&&!path.startsWith('/business/v1/')) {
        if(req.method!=='GET') return reply(405,{error_code:'method_not_allowed'});
        const relative=decodeURIComponent(path).replace(/^\/+/, '')||'index.html';
        const file=resolve(root,relative);
        if(!file.startsWith(root+sep)) return reply(403,{error_code:'path_denied'});
        const content=await readFile(file);
        res.writeHead(200,{'content-type':({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'})[extname(file)]||'application/octet-stream','cache-control':relative==='index.html'?'no-cache':'public,max-age=3600'});res.end(content);return;
      }
      if(['/business/v1/ai','/business/v1/mcp'].includes(path))return reply(404,{error_code:'not_found'});
      const origin=req.headers.origin;
      if(origin&&!allowed.has(origin)) return reply(403,{error_code:'origin_denied'});
      if(origin) {res.setHeader('access-control-allow-origin',origin);res.setHeader('access-control-allow-credentials','true');res.setHeader('vary','Origin');}
      if(req.method==='OPTIONS') {res.setHeader('access-control-allow-methods','GET,POST,OPTIONS');res.setHeader('access-control-allow-headers','content-type,idempotency-key');res.writeHead(204);res.end();return;}
      if(path.startsWith('/business/v1/')){
        if(req.method==='POST'&&!origin&&!(path.startsWith('/business/v1/integration/')&&typeof req.headers.authorization==='string'&&req.headers.authorization.startsWith('Bearer ')))return reply(403,{error_code:'origin_required'});
        if(!businessHandler)return reply(503,{error_code:'business_resources_not_connected'});
        return await businessHandler(req,res);
      }
      if(path==='/native/persist-session'||path==='/native/sign-out'){
        if(path==='/native/sign-out')businessHandler?.invalidateSession?.(req.headers.cookie||'');
        if(path==='/native/persist-session'&&!persistentLoginEnabled)return reply(503,{error_code:'persistent_login_not_enabled'});
        if(req.method!=='POST')return reply(405,{error_code:'method_not_allowed'});
        if(!origin)return reply(403,{error_code:'origin_required'});
        let size=0;for await(const part of req){size+=part.length;if(size>4096)return reply(413,{error_code:'request_too_large'});}
        const crossSite=nativeOrigins.includes(origin);
        if(path==='/native/sign-out'){
          try{await revokeNativeMember(req.headers.cookie,{fetcher});}catch(e){if(e.status!==401)throw e;}
          const legacy=String(req.headers.cookie||'').split(';').map(p=>p.trim().split('=')[0]).filter(n=>/^(?:__Secure-|__Host-)?(?:hub2_preview|better-auth)[A-Za-z0-9_.-]*$/.test(n)).map(n=>n+'=; Path=/; HttpOnly; Secure; SameSite='+(crossSite?'None':'Lax')+'; Max-Age=0');
          res.setHeader('set-cookie',[memberDeviceCookie('',{crossSite,clear:true}),...legacy]);
          return reply(200,{state:'signed_out'});
        }
        const member=await persistNativeMember(req.headers.cookie,req.headers['idempotency-key'],{fetcher,onSessionCookies:renewCookies});
        res.setHeader('set-cookie',[...[].concat(res.getHeader('set-cookie')||[]),memberDeviceCookie(member.token,{crossSite})]);
        return reply(200,{identity:member.identity,user:member.user,persistent_login:true});
      }
      if(path==='/native/upload'){
        if(req.method!=='POST')return reply(405,{error_code:'method_not_allowed'});
        if(!origin)return reply(403,{error_code:'origin_required'});
        return await relayNativeUpload(req,reply,fetcher,renewCookies,{response:res});
      }
      if(path==='/native/file'&&req.method==='GET'){
        const query=new URL(req.url,'http://localhost').searchParams;
        const body=Object.fromEntries(['project_id','material_id','version_id'].map(k=>[k,query.get(k)]));
        if(Object.values(body).some(v=>!v||!(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i).test(v)))return reply(400,{error_code:'invalid_fixed_reference'});
        const ctl=new AbortController();res.once('close',()=>ctl.abort());
        const session=await resolveNativeMember(req.headers.cookie,{fetcher,signal:ctl.signal,onSessionCookies:renewCookies});
        const upstream=await fetcher(CENTRAL+'/hub2-preview/mem/v2/files/read',{method:'POST',headers:{accept:'application/octet-stream','content-type':'application/json',origin:CENTRAL,authorization:'Bearer '+session.token},body:JSON.stringify(body),redirect:'error',signal:ctl.signal});
        if(!upstream.ok){let error;try{error=await upstream.json();}catch{}return reply(upstream.status,{error_code:error?.error_code||'fixed_file_read_rejected'});}
        if(!upstream.body||!upstream.headers.get('content-type')?.startsWith('application/octet-stream'))return reply(502,{error_code:'fixed_file_stream_invalid'});
        const name=(query.get('name')||'文件').slice(0,200).replace(/[\r\n]/g,'');
        res.writeHead(200,{'content-type':'application/octet-stream','cache-control':'no-store','content-disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(name),...(upstream.headers.get('x-hub-read-receipt')?{'x-hub-read-receipt':upstream.headers.get('x-hub-read-receipt')}:{})});
        await pipeline(Readable.fromWeb(upstream.body),res);return;
      }
      const routes={
        '/native/session':{method:'GET',path:PORTAL+'/api/me'},
        '/native/send-code':{method:'POST',path:AUTH+'/email-otp/send-verification-otp'},
        '/native/sign-in':{method:'POST',path:AUTH+'/sign-in/email-otp'},
        '/native/rpc':{method:'POST',path:PORTAL+'/api/rpc'},
      };
      const route=routes[path];
      if(!route) return reply(404,{error_code:'native_route_not_found'});
      if(req.method!==route.method) return reply(405,{error_code:'method_not_allowed'});
      // Browser writes need an exact Origin, not a caller-supplied account or role.
      if(req.method==='POST'&&!origin) return reply(403,{error_code:'origin_required'});
      let body;
      if(req.method==='POST') {
        const parts=[];let size=0;
        for await(const part of req) {size+=part.length;if(size>1024*1024)return reply(413,{error_code:'request_too_large'});parts.push(part);}
        try {body=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{return reply(400,{error_code:'invalid_json'});}
        if(path==='/native/rpc'&&(!TOOLS.has(body.name)||!body.arguments||typeof body.arguments!=='object'||Array.isArray(body.arguments))) return reply(400,{error_code:'tool_not_exposed'});
        if(path==='/native/rpc'&&body.name==='v8.work.save'&&(!body.arguments.idempotency_key||req.headers['idempotency-key']!==body.arguments.idempotency_key))return reply(400,{error_code:'application_idempotency_required'});
        if(path==='/native/rpc'&&body.name==='mem.upload.begin'&&(!body.arguments.idempotency_key||req.headers['idempotency-key']!==body.arguments.idempotency_key)) return reply(400,{error_code:'upload_idempotency_required'});
        if(path!=='/native/rpc') {
          if(typeof body.email!=='string'||!/^\S+@\S+\.\S+$/.test(body.email)||body.email.length>254) return reply(400,{error_code:'invalid_email'});
          if(path==='/native/sign-in'&&(typeof body.otp!=='string'||!/^\d{6}$/.test(body.otp))) return reply(400,{error_code:'invalid_otp'});
          body=path==='/native/sign-in'?{email:body.email,otp:body.otp}:{email:body.email,type:'sign-in'};
        }
      }
      const headers={accept:'application/json',...(req.headers.cookie?{cookie:req.headers.cookie}:{})};
      if(body!==undefined) {headers['content-type']='application/json';headers.origin=CENTRAL;}
      if(req.headers['idempotency-key']) headers['idempotency-key']=req.headers['idempotency-key'];
      let upstreamPath=route.path,rpcName,rpcArguments;
      if(path==='/native/rpc'){
        rpcName=body.name;rpcArguments=body.arguments;
        const target=nativeRoute(body.name,body.arguments);
        if(!target)return reply(400,{error_code:'invalid_native_arguments'});
        const session=await resolveNativeMember(req.headers.cookie,{fetcher,onSessionCookies:renewCookies});
        headers.authorization='Bearer '+session.token;
        delete headers.cookie;
        upstreamPath=target.path;body=target.body;
      }
      if(path==='/native/session'){
        const member=await resolveNativeMember(req.headers.cookie,{fetcher,onSessionCookies:renewCookies});
        if(member.persistent){
          res.setHeader('set-cookie',memberDeviceCookie(member.token,{crossSite:nativeOrigins.includes(origin)}));
          return reply(200,{identity:member.identity,persistent_login:true});
        }
      }
      const upstream=await fetcher(CENTRAL+upstreamPath,{method:route.method,headers,redirect:'manual',signal:AbortSignal.timeout(60000),...(body===undefined?{}:{body:JSON.stringify(body)})});
      if(upstream.status>=300&&upstream.status<400) return reply(502,{error_code:'unexpected_identity_redirect'});
      const cookies=upstream.headers.getSetCookie();
      if(cookies.length)renewCookies(upstream);
      const text=await upstream.text();
      let value;
      try{value=JSON.parse(text);}catch{return reply(502,{error_code:'identity_response_not_json'});}
      if(rpcName?.startsWith('mem.asr.'))console.info(JSON.stringify({event:'native_asr_receipt',action:rpcName,run_id:rpcArguments.run_id||rpcArguments.job_id||value.run_id||value.job_id,status:upstream.status,state:value.state,technical_state:value.technical_state,error_code:value.error_code}));
      if(path==='/native/sign-in'&&upstream.ok) {
        businessHandler?.invalidateSession?.(req.headers.cookie||'');
        if(!cookies.length) return reply(502,{error_code:'native_session_cookie_missing'});
        res.setHeader('set-cookie',[...[].concat(res.getHeader('set-cookie')||[]),memberDeviceCookie('',{crossSite:nativeOrigins.includes(origin),clear:true})]);
        return reply(200,{state:'signed_in'}); // Do not expose native auth tokens in JSON.
      }
      if(path==='/native/session'&&upstream.ok&&persistentLoginEnabled){const identityBody=value?.body&&typeof value.body==='object'?value.body:value;identityBody.persistent_login_available=true;}
      return reply(upstream.status,value);
    }catch(error){if(new URL(req.url,'http://localhost').pathname==='/native/session'&&[401,403].includes(error.status))console.warn(JSON.stringify({event:'member_login_rejected',status:error.status,error_code:/^[a-z0-9_]+$/.test(error.code||'')?error.code:'identity_rejected',native_origin:nativeOrigins.includes(req.headers.origin),device_cookie_present:/(?:^|;\s*)qn_member_device=/.test(req.headers.cookie||''),device_cookie_count:String(req.headers.cookie||'').split(';').filter(x=>x.trim().startsWith('qn_member_device=')).length,device_cookie_format_ok:String(req.headers.cookie||'').split(';').filter(x=>x.trim().startsWith('qn_member_device=')).every(x=>/^[A-Za-z0-9_-]{20,4096}$/.test(x.trim().slice('qn_member_device='.length)))}));if(error.code==='native_session_unavailable')console.warn(JSON.stringify({event:'native_member_transport_failed',path:new URL(req.url,'http://localhost').pathname,status:error.status||502,native_origin:nativeOrigins.includes(req.headers.origin),device_cookie_present:/(?:^|;\s*)qn_member_device=/.test(req.headers.cookie||''),device_cookie_count:String(req.headers.cookie||'').split(';').filter(x=>x.trim().startsWith('qn_member_device=')).length,device_cookie_format_ok:String(req.headers.cookie||'').split(';').filter(x=>x.trim().startsWith('qn_member_device=')).every(x=>/^[A-Za-z0-9_-]{20,4096}$/.test(x.trim().slice('qn_member_device='.length)))}));if(process.env.QN_REAL_QA_DIAGNOSTICS==='1')console.info(JSON.stringify({event:'qa_gateway_failure',code:error.code,status:error.status,name:error.name}));if(res.headersSent){res.destroy();return;}return reply(error.status|| (error.code==='ENOENT'?404:502),{error_code:error.status?error.code:error.code==='ENOENT'?'not_found':'native_upstream_unavailable'});}
  });
}

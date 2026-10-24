import {createAuthEndpoint,APIError,getAuthoritativeSessionFromCtx} from 'better-auth/api';
import {setSessionCookie} from 'better-auth/cookies';
import {verifyOAuthQueryParams} from '@better-auth/oauth-provider';
import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
const failure=(code='wechat_login_rejected',status='UNAUTHORIZED')=>APIError.from(status,{code,message:code==='wechat_configuration_required'?'微信登录尚未配置。':'微信登录未完成，请重新发起。'});
/** Identity provider bridge only. BetterAuth owns sessions and all OAuth grants. */
export function wechatEntryPlugin({pool,prefix,secret,wechat,secure=true}){
 const cookie='hub2_wechat_entry';const attrs={path:prefix+'/v2/auth/sign-in/wechat',httpOnly:true,secure,sameSite:'lax',maxAge:300};
 return{id:'hub2-wechat-entry',endpoints:{
  wechatStandardStart:createAuthEndpoint('/sign-in/wechat/start',{method:'POST'},async ctx=>{
   if(!wechat)throw failure('wechat_configuration_required','SERVICE_UNAVAILABLE');
   const body=ctx.body??{};if(Object.keys(body).some(k=>!['mode','oauth_query'].includes(k))||!['login','bind_current_primary'].includes(body.mode??'login'))throw failure('invalid_input','BAD_REQUEST');
   const signed=body.oauth_query??'';if(typeof signed!=='string'||signed.length>8192||signed&&!await verifyOAuthQueryParams(signed,secret))throw failure('invalid_oauth_signature','BAD_REQUEST');
   let proof=null;
   if(body.mode==='bind_current_primary'){
    const session=await getAuthoritativeSessionFromCtx(ctx);if(!session)throw failure('current_primary_member_required');proof=hash(session.session.token);
   }
   const state=randomBytes(32).toString('base64url');
   try{await pool.query('SELECT authz.wechat_standard_begin($1,$2,$3,$4,$5)',[hash(state),wechat.appId,body.mode??'login',proof,signed]);}catch{throw failure('current_primary_member_required');}
   ctx.setCookie(cookie,state,attrs);return ctx.json({authorization_url:wechat.provider.authorizationUrl(state).toString()});
  }),
  wechatStandardCallback:createAuthEndpoint('/sign-in/wechat/callback',{method:'GET'},async ctx=>{
   if(!wechat)throw failure('wechat_configuration_required','SERVICE_UNAVAILABLE');
   const q=new URL(ctx.request.url).searchParams,state=q.get('state'),code=q.get('code'),stored=ctx.getCookie(cookie);
   if([...q.keys()].some(k=>!['state','code'].includes(k))||!state||!code||!stored||state.length>128||code.length>1024||Buffer.byteLength(state)!==Buffer.byteLength(stored)||!timingSafeEqual(Buffer.from(state),Buffer.from(stored)))throw failure('wechat_browser_state_mismatch');
   ctx.setCookie(cookie,'',{...attrs,maxAge:0});
   let result;try{
    const claim=(await pool.query('SELECT authz.wechat_claim($1,$2,$3) AS claim',[hash(state),hash(code),wechat.appId])).rows[0].claim;
    const identity=await wechat.provider.exchange(code);if(identity.app_id!==wechat.appId||identity.provider!=='wechat'||!identity.open_id)throw Error('wechat_app_mismatch');
    result=(await pool.query('SELECT authz.wechat_standard_finish($1,$2,$3,$4,$5) AS result',[claim,identity.app_id,identity.open_id,randomUUID(),randomBytes(32).toString('base64url')])).rows[0].result;
   }catch{throw failure();}
   for(const key of ['createdAt','updatedAt','expiresAt'])if(result.session[key])result.session[key]=new Date(result.session[key]);
   for(const key of ['createdAt','updatedAt'])result.user[key]=new Date(result.user[key]);
   await setSessionCookie(ctx,result);
   const next=new URLSearchParams({wechat_completed:'1',...(result.oauth_query?{oauth_query:result.oauth_query}:{})});
   throw ctx.redirect(prefix+'/member/login?'+next);
  })
 }};
}

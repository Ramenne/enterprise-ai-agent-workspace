import {DomainError} from '../../../packages/platform/src/http.js';
export interface WechatIdentity {provider:'wechat';app_id:string;open_id:string;union_id?:string;}
export interface WechatProvider {authorizationUrl(state:string):URL; exchange(code:string):Promise<WechatIdentity>;}
export function wechatProvider(config:{appId:string;appSecret:string;redirectUri:string}):WechatProvider {
 if(!config.appId||!config.appSecret||new URL(config.redirectUri).protocol!=='https:')throw new DomainError('wechat_configuration_required',503);
 return {
  authorizationUrl(state){if(!/^[a-zA-Z0-9_-]{32,128}$/.test(state))throw new DomainError('invalid_oauth_state');const url=new URL('https://open.weixin.qq.com/connect/qrconnect');url.search=new URLSearchParams({appid:config.appId,redirect_uri:config.redirectUri,response_type:'code',scope:'snsapi_login',state}).toString();url.hash='wechat_redirect';return url;},
  async exchange(code){if(!code||code.length>1024)throw new DomainError('invalid_wechat_code');const url=new URL('https://api.weixin.qq.com/sns/oauth2/access_token');url.search=new URLSearchParams({appid:config.appId,secret:config.appSecret,code,grant_type:'authorization_code'}).toString();let payload:unknown;
   try{const response=await fetch(url,{signal:AbortSignal.timeout(5000)});if(!response.ok)throw new Error('provider_rejected');payload=await response.json();}catch{throw new DomainError('wechat_provider_unavailable',503,true);}
   if(!payload||typeof payload!=='object')throw new DomainError('wechat_login_rejected',401);const p=payload as Record<string,unknown>;
   if(p['errcode']||typeof p['openid']!=='string'||!p['openid'])throw new DomainError('wechat_login_rejected',401);
   return{provider:'wechat',app_id:config.appId,open_id:p['openid'],...(typeof p['unionid']==='string'?{union_id:p['unionid']}:{})};
  }
 };
}

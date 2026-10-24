import type {WechatProvider} from './wechat.js';
import {createStandardMemberAuth} from '../../../packages/member-auth/src/provider.mjs';
import { betterAuth } from 'better-auth';
import pg from 'pg';
export function createMemberAuth(connectionString:string|pg.Pool,baseURL:string,secret:string,standard?:{wechat?:{appId:string;provider:WechatProvider};resource:string;sendVerificationOTP?:(data:{email:string;otp:string;type:'sign-in'|'email-verification'|'forget-password'})=>Promise<void>;sendVerificationEmail?:(data:{user:{email:string};url:string;token:string})=>Promise<void>}) {
 if(secret.length<32) throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters');
 const pool=typeof connectionString==='string'?new pg.Pool({connectionString,options:'-c search_path=authn,pg_catalog',max:4}):connectionString;
 if(standard)return createStandardMemberAuth({pool,baseURL,secret,...standard});
 const auth=betterAuth({database:pool,secret,baseURL,basePath:'/v2/auth',
  emailAndPassword:{enabled:true,disableSignUp:true,requireEmailVerification:true},
  session:{expiresIn:60*60*8,updateAge:60*60,cookieCache:{enabled:false}},
  advanced:{useSecureCookies:new URL(baseURL).protocol==='https:'},
  trustedOrigins:[new URL(baseURL).origin]});
 return {auth,pool,baseURL};
}

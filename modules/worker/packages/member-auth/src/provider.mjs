import {infrastructureFailure} from '../../platform/src/failure-contract.mjs';
import {wechatEntryPlugin} from './wechat-entry.mjs';
import { betterAuth } from 'better-auth';
import { emailOTP } from 'better-auth/plugins';
import { createAuthMiddleware,createAuthEndpoint,APIError } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { oauthProvider, oauthProviderAuthServerMetadata,verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import { passkey } from '@better-auth/passkey';
import { createHash } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import { randomUUID,randomBytes } from 'node:crypto';

export const WORK_ACTIONS=['mem.upload','mem.read','mem.write','mem.delete','mem.share','mem.process','mem.correct','v8.project.create','v8.project.read','v8.project.convert','v8.project.update','v8.work.open','v8.work.read','v8.work.commit','v8.work.related_candidates','v8.adoption.set','v8.adoption.read','v8.context.prepare','v8.context.materialize','v8.context.read','v8.handoff.record','v8.handoff.read','v8.experience.publish','v8.experience.feedback','v8.experience.read'];
export const SCOPES=['hub2.read','hub2.work','hub2.credential.manage','offline_access'];
export const sha256=value=>createHash('sha256').update(value).digest('hex');
/** One official AS. Public native clients use S256 and opaque member tokens. */
export function createStandardMemberAuth({pool,baseURL,secret,resource,sendVerificationEmail,sendVerificationOTP,wechat,fixture=false}) {
 const base=new URL(baseURL),res=new URL(resource);
 const prefix=base.pathname.replace(/\/$/,'');
 if(base.search||base.hash||base.username||base.password||!/^([\/][a-zA-Z0-9_-]+)*$/.test(prefix))throw new Error('invalid_auth_public_base');
 const authPath=prefix+'/v2/auth';
 if(secret.length<32)throw new Error('member_auth_secret_required');
 if(!fixture&&(base.protocol!=='https:'||res.protocol!=='https:'))throw new Error('member_auth_https_required');
 const mailConfigured=typeof sendVerificationEmail==='function';
 const mail=sendVerificationEmail??(async()=>{throw APIError.from('SERVICE_UNAVAILABLE',{code:'verification_mail_not_configured',message:'邮件验证尚未配置；可使用现有主控凭据绑定 Passkey。'});});
 const otpConfigured=typeof sendVerificationOTP==='function';
 const otpUnavailable=()=>APIError.from('SERVICE_UNAVAILABLE',{code:'email_otp_delivery_unavailable',message:'邮箱验证码发送尚未配置，请稍后再试。'});
 const issuer=baseURL.replace(/\/$/,'')+'/v2/auth';
 const auth=betterAuth({database:pool,secret,baseURL:base.origin,basePath:authPath,
  hooks:{after:createAuthMiddleware(async ctx=>{if(ctx.context.hub2OTPDeliveryUnavailable)throw APIError.from('SERVICE_UNAVAILABLE',{code:'email_otp_delivery_unavailable',message:'验证码邮件暂时无法发送，请稍后重试。'});}),before:createAuthMiddleware(async ctx=>{if(['/email-otp/send-verification-otp','/sign-in/email-otp'].includes(ctx.path)){if(!otpConfigured)throw otpUnavailable();const email=ctx.body?.email;if(typeof email==='string'){const known=(await pool.query('SELECT EXISTS(SELECT FROM authn."user" WHERE lower(email)=lower($1)) AS known',[email])).rows[0].known;if(known&&(await pool.query('SELECT authz.email_otp_member_current($1) AS valid',[email])).rows[0].valid!==true)throw APIError.from('FORBIDDEN',{code:'current_authorized_member_required',message:'当前成员不可用。'});}}if(ctx.path!=='/oauth2/register'||ctx.body?.application_type||!Array.isArray(ctx.body?.redirect_uris)||!ctx.body.redirect_uris.length)return;const native=ctx.body.redirect_uris.every(value=>{try{const u=new URL(value);return u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)&&!u.username&&!u.password;}catch{return false;}});if(native)return{context:{...ctx,body:{...ctx.body,application_type:'native'}}};})},
  trustedOrigins:[base.origin],advanced:{useSecureCookies:base.protocol==='https:',cookiePrefix:prefix?'hub2_preview':'better-auth',defaultCookieAttributes:{path:prefix||'/'}},
  emailAndPassword:{enabled:true,disableSignUp:true,requireEmailVerification:true},
  emailVerification:{sendVerificationEmail:mail,autoSignInAfterVerification:false},
  rateLimit:{enabled:true,storage:'memory'},
  session:{expiresIn:28800,updateAge:3600,cookieCache:{enabled:false}},
  plugins:[emailOTP({disableSignUp:true,otpLength:6,expiresIn:300,allowedAttempts:3,storeOTP:'hashed',rateLimit:{window:60,max:3},async sendVerificationOTP(data,ctx){try{if(!otpConfigured||(await pool.query('SELECT authz.email_otp_member_current($1) AS valid',[data.email])).rows[0].valid!==true){ctx.context.hub2OTPDeliveryUnavailable=true;return;}await sendVerificationOTP(data);}catch{ctx.context.hub2OTPDeliveryUnavailable=true;}}}),wechatEntryPlugin({pool,prefix,secret,wechat,secure:base.protocol==='https:'}),primarySessionPlugin(pool,prefix),passkey({rpID:base.hostname,rpName:'协作平台成员',origin:base.origin}),oauthProvider({
   loginPage:prefix+'/member/login',consentPage:prefix+'/member/consent',disableJwtPlugin:true,
   scopes:SCOPES,grantTypes:['authorization_code','refresh_token'],
   allowDynamicClientRegistration:true,allowUnauthenticatedClientRegistration:true,
   clientRegistrationRequirePKCE:true,clientRegistrationDefaultResources:[resource],accessTokenExpiresIn:900,refreshTokenExpiresIn:28800,refreshTokenReuseInterval:0,
   resources:[{identifier:resource,name:'Hub2 MCP',allowedScopes:SCOPES,dpopBoundAccessTokensRequired:false}],
   storeTokens:{hash:async token=>sha256(token)}
  })]});
 return{auth,pool,baseURL,prefix,mailConfigured,otpConfigured,issuer,resource,metadata:oauthProviderAuthServerMetadata(auth),verifyQuery:query=>verifyOAuthQueryParams(query,secret),assertPolicy:async()=>{const result=await pool.query('SELECT authz.oauth_policy_match($1,$2)AS matched',[issuer,resource]);if(result.rows[0]?.matched!==true)throw new Error('oauth_issuer_resource_policy_mismatch');},fixture};
}
/** Existing primary identity chooses its genuine email; delivery proves ownership.
 * Domain mapping comes from current authz actor, never email/name/old role.
 */
export async function registerVerifiedMember(provider,primaryToken,{email,name,password,send_email=true}){
 if(typeof email!=='string'||!/^\S+@\S+\.\S+$/.test(email)||typeof name!=='string'||!name.trim()||typeof password!=='string'||password.length<12||password.length>128)throw new Error('member_registration_input_invalid');
 const userId=randomUUID(),accountId=randomUUID(),passwordHash=await hashPassword(password);
 const connection=await provider.pool.connect();
 try{await connection.query('BEGIN');await connection.query('SELECT authz.register_member_account($1,$2,$3,$4,$5,$6)',[sha256(primaryToken),userId,email.toLowerCase(),name.trim(),accountId,passwordHash]);await connection.query('COMMIT');}
 catch(e){await connection.query('ROLLBACK');throw e;}finally{connection.release();}
 if(send_email===false||!provider.mailConfigured)return{state:'primary_bound_email_unverified',next_step:'sign_in_with_current_primary_then_register_passkey',member_mapping:'current_primary_identity',email_verified:false};
 await provider.auth.api.sendVerificationEmail({body:{email:email.toLowerCase(),callbackURL:provider.prefix+'/member/login'}});
 return{state:'verification_sent',next_step:'verify_real_email_then_login_or_register_passkey',member_mapping:'current_primary_identity'};
}

/** Passwordless registration preserves a pending account on delivery failure.
 * No password account or verified flag is manufactured; actual OTP login proves email control.
 */
export async function registerOTPMember(provider,primaryToken,body){
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['email','name'].includes(k))||typeof body.email!=='string'||!/^\S+@\S+\.\S+$/.test(body.email)||body.email.length>254||typeof body.name!=='string'||!body.name.trim()||body.name.trim().length>200)throw APIError.from('BAD_REQUEST',{code:'member_registration_input_invalid',message:'请提供本人邮箱和显示名称。'});
 if(!provider.otpConfigured)throw APIError.from('SERVICE_UNAVAILABLE',{code:'email_otp_delivery_unavailable',message:'验证码邮件尚未配置。'});
 const connection=await provider.pool.connect();let pending;
 try{await connection.query('BEGIN');pending=(await connection.query('SELECT authz.register_member_otp($1,$2,$3,$4) AS result',[sha256(primaryToken),randomUUID(),body.email.toLowerCase().trim(),body.name.trim()])).rows[0].result;await connection.query('COMMIT');}
 catch(e){await connection.query('ROLLBACK');const failure=infrastructureFailure(e);if(failure?.status===401||failure?.status===403)throw APIError.from(failure.status===401?'UNAUTHORIZED':'FORBIDDEN',{code:failure.status===401?'unauthenticated':'current_primary_member_required',message:'请使用本人当前有效主凭据登记邮箱。'});if(e.code==='23505')throw APIError.from('CONFLICT',{code:'member_email_already_bound',message:'当前成员或邮箱已有绑定，请使用现有邮箱登录。'});throw e;}finally{connection.release();}
 try{await provider.auth.api.sendVerificationOTP({body:{email:body.email.toLowerCase().trim(),type:'sign-in'}});}
 catch{throw APIError.from('SERVICE_UNAVAILABLE',{code:'email_otp_delivery_unavailable',message:'邮箱绑定已保存，验证码发送暂不可用，请用同一邮箱重试。'});}
 return{...pending,state:'otp_sent',next_step:'submit_email_otp',password_required:false};
}

/** Existing primary proof creates an official browser session for its own mapped member.
 * The SQL function rechecks the proof under the same actor lock as session insertion.
 * No email assertion and no new OAuth grant are created. */
function primarySessionPlugin(pool,prefix){
 const proof=ctx=>ctx.headers?.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
 const failure=()=>APIError.from('UNAUTHORIZED',{code:'current_primary_member_required',message:'引导凭据无效、已过期或已使用。'});
 const sessionResponse=async(ctx,sql,hash)=>{let result;try{result=(await pool.query(sql,[hash,randomUUID(),randomBytes(32).toString('base64url')])).rows[0].result;}catch{throw failure();}
  for(const key of ['createdAt','updatedAt','expiresAt'])if(result.session[key])result.session[key]=new Date(result.session[key]);
  for(const key of ['createdAt','updatedAt'])result.user[key]=new Date(result.user[key]);
  await setSessionCookie(ctx,result);return ctx.json({state:'authenticated',email_verified:result.user.emailVerified,member_mapping:'current_primary_identity'});
 };
 return{id:'hub2-primary-session',endpoints:{
 signInPrimary:createAuthEndpoint('/sign-in/primary',{method:'POST'},async ctx=>{const token=proof(ctx);if(!token)throw failure();return sessionResponse(ctx,'SELECT authz.member_primary_session($1,$2,$3) AS result',sha256(token));}),
 issueMemberBootstrap:createAuthEndpoint('/member-bootstrap/issue',{method:'POST'},async ctx=>{const token=proof(ctx);if(!token)throw failure();const code=randomBytes(32).toString('base64url');let result;try{result=(await pool.query('SELECT authz.member_entry_bootstrap_issue($1,$2) AS result',[sha256(token),sha256(code)])).rows[0].result;}catch{throw failure();}return ctx.json({...result,path:prefix+'/member/bootstrap',code});}),
 signInBootstrap:createAuthEndpoint('/sign-in/bootstrap',{method:'POST'},async ctx=>{const code=proof(ctx);if(!code)throw failure();return sessionResponse(ctx,'SELECT authz.member_entry_bootstrap_consume($1,$2,$3) AS result',sha256(code));})
 }};
}

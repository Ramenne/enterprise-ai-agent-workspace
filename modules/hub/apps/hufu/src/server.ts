import{installProductServices}from'./product-services.mjs';
import{installProjectPrivacy}from'./project-privacy.js';
import{normalizeCredentialCreate,requestedProjectIds,confirmsCurrentProjectScope,CredentialCreateInputError}from'./credential-create-input.mjs';
import {z}from'zod';
import {registerMaterialSharing}from'./material-sharing.mjs';
import{installHufuUsage}from'./hufu-usage.mjs';
import{installProviderManagement,type ProviderManagementRelay}from'./provider-management.js';
import {installStandardEntry,authRequest} from '../../../packages/member-auth/src/entry.mjs';
import {installResourceExecution} from './resource-execution-route.js';
import {installDiscoveryDecision} from './discovery-route.js';
import {installLegacyBridge} from './legacy-bridge.js';
import {installBaizeDirectory} from './hufu-baize-directory.mjs';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { server, bearer, sameSecret, DomainError } from '../../../packages/platform/src/http.js';
import { sqlFunction } from '../../../packages/platform/src/db.js';
import { digest } from '../../../packages/platform/src/canonical.js';
import { createMemberAuth } from './auth.js';
import { type WechatProvider } from './wechat.js';
import { normalizeSource } from './source.js';
export interface HufuConfig { pool: pg.Pool;usagePool?:pg.Pool;usageSpoolDirectory?:string; providerManagementRelay?:ProviderManagementRelay; serviceKeys: Record<'mem'|'v8'|'worker',string>; credentialKey?:string; resourceExecutionKey?:string; memberAuth?:ReturnType<typeof createMemberAuth>; wechat?:{appId:string;provider:WechatProvider}; }
export const tokenHash=(token:string):string=>createHash('sha256').update(token).digest('hex');
export function createServer(config:HufuConfig) {
 const app=server('hufu');installProductServices(app,{pool:config.pool,bearer,credentialKey:config.credentialKey});installProjectPrivacy(app,config.pool);registerMaterialSharing(app,{z,bearer,sqlFunction,pool:config.pool,DomainError});installHufuUsage(app,{pool:config.pool,usagePool:config.usagePool,memberAuth:config.memberAuth,directory:config.usageSpoolDirectory});installProviderManagement(app,config.pool,config.providerManagementRelay);installDiscoveryDecision(app,config.pool,config.serviceKeys);
 app.post('/v2/client/lookup',{logLevel:'silent'},async request=>{
  const parsed=z.object({client_id:z.uuid()}).strict().safeParse(request.body);
  if(!parsed.success)throw new DomainError('invalid_input');
  return sqlFunction(config.pool,'authz.client_identity_lookup',[tokenHash(bearer(request)),parsed.data.client_id]);
 });
 installLegacyBridge(app,config.pool);
 installBaizeDirectory(app,{pool:config.pool,bearer,sqlFunction,DomainError});
 if(config.resourceExecutionKey)installResourceExecution(app,config.pool,config.resourceExecutionKey);
 if(config.memberAuth) {
  const member=config.memberAuth;
  if('metadata' in member)void installStandardEntry(app,member);
  app.all('/v2/auth/*',{logLevel:'silent'},async(request,reply)=>{
   const incoming=authRequest(request,member.baseURL);
   const response=await member.auth.handler(incoming);
   reply.code(response.status);response.headers.forEach((value,key)=>{if(key!=='set-cookie')reply.header(key,value);});
   const cookies=response.headers.getSetCookie();if(cookies.length)reply.header('set-cookie',cookies);
   return reply.send(await response.text());
  });
 }
 for(const [path,command] of Object.entries({'/v2/credentials/create':'credential.create','/v2/credentials/revoke':'credential.revoke','/v2/credentials/rotate':'credential.rotate','/v2/qualifications/grant':'qualification.grant','/v2/qualifications/revoke':'qualification.revoke','/v2/qualifications/freeze':'qualification.freeze','/v2/qualifications/unfreeze':'qualification.unfreeze','/v2/management/delegate':'management.delegate'})) {
  app.post(path,async(request,reply)=>{
   if(command==='qualification.freeze'||command==='qualification.unfreeze')return reply.code(400).send({state:'unsupported',error_code:'permission_freezing_removed',effect:'none',next_step:'request_new_authorization_after_revoke'});
   const rawBody=request.body as Record<string,unknown>;let body=rawBody;
   if(!body||Array.isArray(body)||typeof body!=='object')throw new DomainError('invalid_input');
   const requestDigest=digest({command,body:rawBody});
   if(command==='credential.create')try{body=normalizeCredentialCreate(rawBody);}catch(error){if(error instanceof CredentialCreateInputError)return reply.code(400).send({state:'failed',error_code:error.code,validation_errors:error.validation_errors,retained_state:'unchanged',next_step:'correct_scope_fields;no_credential_issued'});throw error;}
if(command==='credential.create'&&Object.hasOwn(body,'qualification_ids'))throw new DomainError('qualification_filter_not_implemented',400,false);
   const key=request.headers['idempotency-key'];if(typeof key!=='string'||!key||key.length>200)throw new DomainError('idempotency_key_required');
   let token:string;
   if(request.headers.authorization)token=bearer(request);
   else if(config.memberAuth){const h=new Headers();if(request.headers.cookie)h.set('cookie',request.headers.cookie);const session=await config.memberAuth.auth.api.getSession({headers:h});if(!session)throw new DomainError('unauthenticated',401);token=session.session.token;}
   else throw new DomainError('unauthenticated',401);
   let generated:string|undefined;
   if(command==='credential.create'||command==='credential.rotate'){
    if(!config.credentialKey||config.credentialKey.length<32)throw new DomainError('credential_issuance_unconfigured',503);
    const identity=await sqlFunction<Record<string,unknown>>(config.pool,'authz.authenticate',[tokenHash(token)]);
    if(typeof identity['actor_id']!=='string'||!identity['actor_id'])throw new DomainError('unauthenticated',401);
    // Stable owner/operation derivation permits a verified primary login to
    // recover an issuance/rotation response lost after COMMIT; SQL binds replay
    // to its original issuer or actual primary authority, never a label.
    generated='hub2_'+createHmac('sha256',config.credentialKey).update(identity['actor_id']+'\n'+key+'\n'+requestDigest).digest('base64url');
   }
   const result=await sqlFunction(config.pool,'authz.manage',[tokenHash(token),command,{...body,...(generated?{token_hash:tokenHash(generated)}:{})},key,requestDigest]);
   if(command==='credential.create'&&!confirmsCurrentProjectScope(result,requestedProjectIds(rawBody)))return reply.code(409).send({state:'scope_confirmation_required',error_code:'current_credential_scope_not_confirmed',client_id:result['client_id'],credential_id:result['credential_id'],operation_id:result['operation_id'],credential_delivery:'unavailable',retained_state:'original_CID_receipt_and_key_preserved',next_step:'inspect_and_narrow_existing_CID_under_current_management;do_not_reissue_or_change_key'});
   return {...result,...(generated&&result['credential_delivery']==='available'?{credential:generated}: {})};
  });
 }

 app.post('/v2/projects/work-preset',async request=>{
  const body=request.body as Record<string,unknown>;
  if(!body||Object.keys(body).some(k=>!['project_id','actions','resource_selector'].includes(k))||typeof body['project_id']!=='string'||!/^[0-9a-f-]{36}$/.test(body['project_id'])||!Array.isArray(body['actions'])||body['actions'].some(a=>typeof a!=='string')||!body['resource_selector']||typeof body['resource_selector']!=='object')throw new DomainError('invalid_input');
  return sqlFunction(config.pool,'authz.set_work_preset',[tokenHash(bearer(request)),body['project_id'],body['actions'],body['resource_selector']]);
 });
 for(const [path,fn]of Object.entries({'/v2/providers/capabilities/enumerate':'authz.provider_capabilities_enumerate','/v2/providers/capabilities/read':'authz.provider_capabilities_read','/v2/providers/capabilities/store':'authz.provider_capabilities_store'}))app.post(path,async request=>{const body=request.body;if(!body||typeof body!=='object'||Array.isArray(body))throw new DomainError('invalid_input');return sqlFunction(config.pool,fn,[tokenHash(bearer(request)),body]);});
 const memberIdentity=async(request:Parameters<typeof bearer>[0])=>{const proof=tokenHash(bearer(request));const identity=await sqlFunction(config.pool,'authz.authenticate',[proof]);const profile=await sqlFunction(config.pool,'authz.member_profile_self',[proof]);return {...identity,member_profile:profile};};
 app.get('/v2/me',memberIdentity);
 app.get('/whoami',memberIdentity);
 app.post('/internal/decision',async request=>{
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.ip)) throw new DomainError('forbidden',403);
  const body=request.body as Record<string,unknown>;
  if(!body||typeof body!=='object'||Array.isArray(body)) throw new DomainError('invalid_input');
  for(const key of ['actor_id','member_id','client_id','principal_id']) if(key in body) throw new DomainError('subject_override',403);
  const header=request.headers['x-hub-service-key'];
  const actual=typeof header==='string'?header:undefined;
  const matches=(['mem','v8','worker'] as const).filter(a=>sameSecret(actual,config.serviceKeys[a]));
  if(matches.length!==1||matches[0]!==body['audience']) throw new DomainError('invalid_service_audience',403);
  if(typeof body['action']!=='string'||typeof body['request_digest']!=='string'||!/^[a-f0-9]{64}$/.test(body['request_digest'])||!body['resource']||typeof body['resource']!=='object') throw new DomainError('invalid_input');
  return sqlFunction(config.pool,'authz.issue_handle',[tokenHash(bearer(request)),matches[0],body['action'],body['resource'],body['request_digest'],normalizeSource(body['source_context'])]);
 });
 app.get('/v2/auth/wechat/status',async()=>({provider:'wechat',state:config.wechat?'configured_not_live_verified':'configuration_required',available:Boolean(config.wechat)}));
 app.post('/v2/auth/wechat/start',async request=>{
  if(!config.wechat)throw new DomainError('wechat_configuration_required',503);
  const body=request.body as Record<string,unknown>;
  if(!body||Object.keys(body).some(k=>k!=='client_label')||!['codex','qoder','chatgpt','browser'].includes(String(body['client_label'])))throw new DomainError('invalid_input');
  const state=randomBytes(32).toString('base64url');
  const result=await sqlFunction(config.pool,'authz.wechat_begin',[tokenHash(state),config.wechat.appId,body['client_label']]);
  return{...result,authorization_url:config.wechat.provider.authorizationUrl(state).toString()};
 });
 app.get('/v2/auth/wechat/callback',{logLevel:'silent'},async request=>{
  if(!config.wechat)throw new DomainError('wechat_configuration_required',503);
  const query=request.query as Record<string,unknown>;
  if(Object.keys(query).some(k=>!['state','code'].includes(k))||typeof query['state']!=='string'||typeof query['code']!=='string'||query['state'].length>128||query['code'].length>1024)throw new DomainError('invalid_input');
  const claim=await sqlFunction<string>(config.pool,'authz.wechat_claim',[tokenHash(query['state']),tokenHash(query['code']),config.wechat.appId]);
  const identity=await config.wechat.provider.exchange(query['code']);
  if(identity.app_id!==config.wechat.appId)throw new DomainError('wechat_app_mismatch',401);
  const token='hub2_'+randomBytes(32).toString('base64url');
  const result=await sqlFunction(config.pool,'authz.wechat_finish',[claim,identity.app_id,identity.open_id,tokenHash(token)]);
  return{...result,credential:token};
 });
 app.post('/v2/sessions/start',async request=>{
  const key=request.headers['idempotency-key'];if(typeof key!=='string'||!key||key.length>200)throw new DomainError('idempotency_key_required');
  if(!config.credentialKey||config.credentialKey.length<32)throw new DomainError('credential_issuance_unconfigured',503);
  const token=bearer(request),seed=tokenHash(token)+'\n'+key;
  const access='hub2_'+createHmac('sha256',config.credentialKey).update('access\n'+seed).digest('base64url');
  const refresh='hub2r_'+createHmac('sha256',config.credentialKey).update('refresh\n'+seed).digest('base64url');
  const result=await sqlFunction(config.pool,'authz.session_start',[tokenHash(token),tokenHash(access),tokenHash(refresh),key,digest({action:'session.start',key})]);
  return{...result,access_token:access,refresh_token:refresh};
 });
 app.post('/v2/sessions/refresh',async(request,reply)=>{
  const body=request.body as Record<string,unknown>;if(!body||Object.keys(body).some(k=>k!=='refresh_token')||typeof body['refresh_token']!=='string'||body['refresh_token'].length>4096)throw new DomainError('invalid_input');
  const access='hub2_'+randomBytes(32).toString('base64url'),refresh='hub2r_'+randomBytes(32).toString('base64url');
  const result=await sqlFunction(config.pool,'authz.session_refresh',[tokenHash(body['refresh_token']),tokenHash(access),tokenHash(refresh)]);
  if(result['state']==='rejected')return reply.code(401).send(result);
  return{...result,access_token:access,refresh_token:refresh};
 });
 for(const [path,command] of Object.entries({'/v2/principals/disable':'principal.disable','/v2/sessions/logout-all':'session.logout_all','/v2/sessions/logout':'session.logout','/v2/clients/disable':'client.disable'}))app.post(path,async request=>{
  const body=request.body as Record<string,unknown>;if(!body||Object.keys(body).some(k=>k!=='target_id')||typeof body['target_id']!=='string'||!/^[0-9a-f-]{36}$/.test(body['target_id']))throw new DomainError('invalid_input');
  return sqlFunction(config.pool,'authz.stop',[tokenHash(bearer(request)),command,body['target_id']]);
 });
 return app;
}


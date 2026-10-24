import {createHash,randomBytes} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import type pg from 'pg';
import {z} from 'zod';
import {bearer,DomainError} from '../../../packages/platform/src/http.js';
import {sqlFunction} from '../../../packages/platform/src/db.js';

export const LEGACY_HUFU_VERIFY_URL='https://hufu.example.invalid/hufu/auth/verify';
export const LEGACY_HUFU_ISSUER='service.example.invalid/access-verify';
export const LEGACY_PRIMARY_SOURCE='legacy_hufu_verified';
export interface VerifiedLegacyIdentity {issuer:typeof LEGACY_HUFU_ISSUER;subjectKind:'username';subject:string;proofExpiresAt:Date;roleMetadata?:string;}
export interface LegacyIdentityVerifier {verify(accessToken:string):Promise<VerifiedLegacyIdentity>;}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');

/** Fixed upstream identity verification, never a caller-selected URL or local JWT signature. */
export class FixedHufuLegacyVerifier implements LegacyIdentityVerifier {
 async verify(accessToken:string):Promise<VerifiedLegacyIdentity>{
  if(!accessToken||accessToken.length>4096)throw new DomainError('legacy_access_proof_required',401);
  let response:Response;
  try{response=await fetch(LEGACY_HUFU_VERIFY_URL,{method:'GET',redirect:'error',headers:{authorization:'Bearer '+accessToken,accept:'application/json'},signal:AbortSignal.timeout(8000)});}
  catch{throw new DomainError('legacy_identity_verifier_unavailable',503,true);}
  if(!response.ok){await response.body?.cancel();throw new DomainError(response.status>=500?'legacy_identity_verifier_unavailable':'legacy_access_proof_invalid',response.status>=500?503:401,response.status>=500);}
  const reader=response.body?.getReader();if(!reader)throw new DomainError('legacy_identity_response_invalid',503);
  const parts:Uint8Array[]=[];let size=0;
  try{while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>16384){await reader.cancel();throw new DomainError('legacy_identity_response_invalid',503);}parts.push(chunk.value);}}
  finally{reader.releaseLock();}
  let body:unknown;try{body=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw new DomainError('legacy_identity_response_invalid',503);}
  const parsed=z.object({valid:z.literal(true),username:z.string().min(1).max(256),expires_at:z.number().int().positive(),role:z.string().max(100).optional()}).passthrough().safeParse(body);
  if(!parsed.success||parsed.data.expires_at<=Date.now())throw new DomainError('legacy_access_proof_invalid',401);
  // Current /verify returns an exact server username and millisecond expiry.
  // Nickname/dept/old role never choose the new principal or its capabilities.
  return{issuer:LEGACY_HUFU_ISSUER,subjectKind:'username',subject:parsed.data.username,proofExpiresAt:new Date(parsed.data.expires_at),...(parsed.data.role?{roleMetadata:parsed.data.role}:{})};
 }
}

const binding={audience:z.literal('hub2'),client_label:z.string().trim().min(1).max(80),client_actions:z.array(z.string().min(1).max(100)).max(80).default([])};
const start=z.object({client_label:binding.client_label,client_actions:binding.client_actions,audience:binding.audience.default('hub2')}).strict();
const finish=z.object({...binding,challenge_id:z.uuid(),nonce:z.string().min(32).max(200)}).strict();
function input<T>(schema:z.ZodType<T>,body:unknown):T{const r=schema.safeParse(body);if(!r.success)throw new DomainError('invalid_legacy_bridge_input',400);return r.data;}
function scopedActions(values:string[]){return [...new Set(values)].sort();}
/** Inject verifier only into isolated module tests; normal Hufu uses the fixed HTTPS verifier. */
export function installLegacyBridge(app:FastifyInstance,pool:pg.Pool,verifier:LegacyIdentityVerifier=new FixedHufuLegacyVerifier()){
 app.post('/v2/auth/legacy/start',{logLevel:'silent'},async request=>{
  const b=input(start,request.body),nonce=randomBytes(32).toString('base64url'),actions=scopedActions(b.client_actions);
  const challenge=await sqlFunction<Record<string,unknown>>(pool,'authz.legacy_bridge_begin',[hash(nonce),b.audience,b.client_label,actions]);
  return{...challenge,nonce,binding:{audience:b.audience,client_label:b.client_label,client_actions:actions},proof_kind:'old_hufu_verified_access',next_step:'submit_binding_and_nonce_with_old_access_bearer'};
 });
 app.post('/v2/auth/legacy/finish',{logLevel:'silent'},async request=>{
  const b=input(finish,request.body),actions=scopedActions(b.client_actions);
  // Check nonce/binding/expiry before network IO without consuming it or holding SQL locks.
  await sqlFunction(pool,'authz.legacy_bridge_check',[b.challenge_id,hash(b.nonce),b.audience,b.client_label,actions]);
  const identity=await verifier.verify(bearer(request));
  if(identity.issuer!==LEGACY_HUFU_ISSUER||identity.subjectKind!=='username'||identity.proofExpiresAt.getTime()<=Date.now())throw new DomainError('legacy_access_proof_invalid',401);
  const credential='hub2_'+randomBytes(32).toString('base64url');
  let result:Record<string,unknown>;
  try{result=await sqlFunction(pool,'authz.legacy_bridge_finish',[b.challenge_id,hash(b.nonce),b.audience,b.client_label,actions,identity.subject,identity.proofExpiresAt.toISOString(),hash(credential),identity.roleMetadata??null]);}
  catch(error){const message=(error as {message?:string}).message;if(message==='legacy_membership_mapping_required')throw new DomainError('legacy_membership_mapping_required',403);throw error;}
  return{...result,credential,authority_source:LEGACY_PRIMARY_SOURCE,credential_delivery:'once',authorization_note:'existing_2_membership_and_current_qualification;old_role_not_imported',next_step:'use_member_client_or_issue_scoped_API_key_with_existing_240_credential_contract'};
 });
}

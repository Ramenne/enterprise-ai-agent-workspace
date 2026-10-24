import {installGovernanceInbox} from './governance-inbox.mjs';
import {installExpansion} from './expansion.js';
import {installGovernance} from './governance.js';
import {installDiscovery} from './discovery.js';
import {installChanges} from '../../../packages/platform/src/changes.js';
import {installUsage} from '../../../packages/platform/src/usage.js';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { server, bearer, DomainError } from '../../../packages/platform/src/http.js';
import { database, sqlFunction } from '../../../packages/platform/src/db.js';
import { decide, type DecisionConfig } from '../../../packages/platform/src/decision.js';
import { canonical, digest, sha256 } from '../../../packages/platform/src/canonical.js';
import { sourceFromRequest } from '../../../packages/platform/src/source.js';
export interface V8Config extends DecisionConfig { databaseUrl: string; pool?: pg.Pool; usagePool?:pg.Pool; usageSpoolDirectory?:string; }
const uuid = z.uuid(), text = z.string().min(1).max(4000), revision=z.number().int().positive();
export const fixedRef=z.object({material_id:uuid,version_id:uuid,sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const key=z.string().min(1).max(200), base={project_id:uuid}, mutation={...base,idempotency_key:key.optional()};
const json=z.json();
const reference=z.object({...fixedRef.shape,role:z.string().min(1).max(100).default('result')}).strict();
const basis=z.object({explanation:json.optional(),work_read_receipt_id:uuid.optional(),use_origin:z.string().max(200).optional(),refs:z.array(z.object({fixed_ref:fixedRef,read_receipt_id:uuid.optional(),use_origin:z.string().max(200).optional()}).catchall(json)).default([])}).catchall(json);
const related=z.object({work_item_id:uuid,basis:basis.default({refs:[]}),supersedes:uuid.optional(),state:z.enum(['active','withdrawn','corrected']).default('active')}).strict();
const coverage=z.enum(['raw_export','user_attachment','agent_summary','partial','unknown']);
const decision=z.object({text:json.optional(),reason_ref:fixedRef.optional()}).catchall(json);
const contextConfig=z.object({effective_decisions:z.array(decision).default([]),dissenting_views:z.array(decision).default([]),rejected_explanations:z.array(decision).default([]),fixed_refs:z.array(reference).optional(),limitations:z.array(json).default([]),pending_operations:z.array(z.object({operation_id:uuid.optional(),state:z.string().max(100).optional(),next_step:json.optional(),responsible_scope:json.optional()}).catchall(json)).default([]),next_steps:z.array(json).optional(),source_coverage:coverage.default('unknown'),complete:z.boolean().default(false),estimated_tokens:z.number().int().nonnegative().optional(),token_budget:z.number().int().positive().optional(),ttl_seconds:z.number().int().min(30).max(900).default(900),refreshes_context_id:uuid.optional(),judgments:json.optional(),properties:z.record(z.string(),json).optional()}).strict();
const workFields={...mutation,work_item_id:uuid.optional(),expected_revision:revision.optional(),goal:z.string().max(4000).optional(),summary:z.string().max(8000).optional(),description:z.string().max(8000).optional(),explanation:json.optional(),outputs:z.array(reference).max(100).default([]),related_evaluated:z.boolean().optional(),related_assessment:z.enum(['assessed','partial','unassessed']).optional(),related:z.array(related).max(100).default([]),completion_state:z.enum(['open','in_progress','completed','cancelled']).optional(),properties:z.record(z.string(),json).optional(),execution_claims:json.optional(),context:z.union([z.boolean(),contextConfig]).optional()};
const schemas: Array<[string,string,string,z.ZodType]> = [
 ['/v2/projects/convert','project_convert','v8.project.convert',z.object({...mutation,expected_revision:revision,visibility:z.enum(['personal','team','private']),kind:z.enum(['project','dialogue']),manager_id:uuid.optional(),reason:json.optional(),judgment:json.optional()}).strict()],
 ['/v2/projects/read','project_read','v8.project.read',z.object(base).strict()],
 ['/v2/work-items/open','work_open','v8.work.open',z.object({...mutation,goal:z.string().max(4000).default('目标尚未说明'),description:z.string().max(8000).default('')}).strict()],
 ['/v2/work-items/save','work_save','v8.work.commit',z.object({...workFields,context:z.union([z.boolean(),contextConfig]).default(true)}).strict()],
 ['/v2/work-items/commit','work_commit','v8.work.commit',z.object({...workFields,work_item_id:uuid}).strict()],
 ['/v2/work-items/history','work_history','v8.work.read',z.object({...base,work_item_id:uuid}).strict()],
 ['/v2/work-items/read','work_read','v8.work.read',z.object({...base,work_item_id:uuid}).strict()],
 ['/v2/work-items/pending-registration','pending_registration','v8.work.read',z.object({...base,limit:z.number().int().min(1).max(100).default(20),cursor:z.number().int().nonnegative().default(0)}).strict()],
 ['/v2/work-items/related-candidates','related_candidates','v8.work.related_candidates',z.object({...base,work_item_id:uuid.optional(),fixed_refs:z.array(fixedRef).max(100).default([]),query:z.string().max(200).default(''),since:z.iso.datetime().optional(),until:z.iso.datetime().optional(),participants:z.array(uuid).max(100).default([]),limit:z.number().int().min(1).max(50).default(10),cursor:z.number().int().nonnegative().default(0)}).strict()],
 ['/v2/adoptions','adoption_set','v8.adoption.set',z.object({...mutation,work_item_id:uuid,expected_work_revision:revision.optional(),expected_adoption_revision:z.number().int().nonnegative().default(0),fixed_ref:fixedRef,role:z.string().min(1).max(100).default('adopted'),reason:json.optional(),judgment:json.optional(),use_origin:z.string().max(200).optional(),read_receipt_id:uuid.optional()}).strict()],
 ['/v2/contexts/prepare','context_prepare','v8.context.prepare',z.object({...contextConfig.shape,...mutation,work_item_id:uuid,expected_work_revision:revision.optional()}).strict()],
 ['/v2/handoffs','handoff_record','v8.handoff.record',z.object({...mutation,work_item_id:uuid,context_id:uuid.optional(),to_actor_id:uuid.optional(),rationale:z.string().max(4000).optional(),next_actions:z.array(json).default([]),context:contextConfig.optional()}).strict()],
 ['/v2/handoffs/accept','handoff_accept','v8.handoff.record',z.object({...mutation,handoff_id:uuid,state:z.enum(['accepted','continued','declined']).default('continued'),context_view_id:uuid.optional(),mode:z.enum(['complete','clipped']).default('clipped')}).strict()],
 ['/v2/impact-judgments','impact_judge','v8.work.commit',z.object({...mutation,work_item_id:uuid.optional(),context_id:uuid.optional(),choice:z.string().min(1).max(200),applicable_scope:json.optional(),reason:json.optional(),evidence:z.array(fixedRef).default([]),supersedes:uuid.optional(),properties:z.record(z.string(),json).optional(),uncertainty:json.optional()}).strict()],
 ['/v2/impact-judgments/read','impact_read','v8.work.read',z.object({...base,work_item_id:uuid.optional(),context_id:uuid.optional()}).strict()],
 ['/v2/experiences','experience_publish','v8.experience.publish',z.object({...mutation,work_item_id:uuid,fixed_ref:fixedRef,conditions:json.default({}),state:z.enum(['proposed','published']).default('published'),evidence:z.array(fixedRef).default([]),supersedes:uuid.optional()}).strict()],
 ['/v2/experience-feedback','experience_feedback','v8.experience.feedback',z.object({...mutation,experience_id:uuid,work_item_id:uuid,kind:z.enum(['used','counterexample','correction','inapplicable']),body_ref:fixedRef,evidence:z.array(fixedRef).default([])}).strict()],
 ['/v2/adoptions/read','adoption_read','v8.adoption.read',z.object({...base,work_item_id:uuid}).strict()],
 ['/v2/experiences/read','experience_read','v8.experience.read',z.object({...base,experience_id:uuid.optional()}).strict()],
 ['/v2/handoffs/read','handoff_read','v8.handoff.read',z.object({...base,handoff_id:uuid}).strict()],
 ['/v2/contexts/read','context_read','v8.context.read',z.object({...base,context_id:uuid}).strict()],
 ['/v2/work-read-receipts','work_mark_read','v8.work.read',z.object({...base,read_receipt_id:uuid,state:z.literal('acknowledged')}).strict()],
 ['/v2/operations/query','operation_read','v8.work.read',z.object({...base,operation_id:uuid}).strict()]
];
// Explicit response fields suppress unexpected SQL metadata and any future secret columns.
const responseKeys=new Set(['operation_id','state','domain_revision','fixed_refs','receipt','coverage','retryable','error_code','retained_state','next_step','project','work_item','work_item_id','short_no','read_receipt_id','relations','results','adoptions','items','next_cursor','context_id','manifest_hash','expires_at','view_id','returned_view','handoff_id','experience_id','feedback_id','adoption_id','adoption_revision','source_context_id','project_id','idempotency_key','completion_claim','related_assessment','pending_enrichment','update_id','update_hash','write_mode','updates','warnings','delta','candidate','judgment_id','judgment_hash','use_evidence','artifact_availability','manifest_canonical_text','canonical_format','returned_count','returned_view_hash','expansion','statement_id','kind','document_hash','sha256','size','path','bytes_base64','text','utf8_state','chunk_sha256','range','next_offset','appearance','request_usage','measured_at','history','schema_change','unknown_scope','response_path_budget_truncated','statistics_are_not_schema_columns','current_summary','brief_semantics','summary_semantics']);
const projectKeys=new Set(['id','organization_id','kind','visibility','owner_id','manager_id','title','revision','epoch','event_revision','state','created_at']);
const workKeys=new Set(['id','short_no','project_id','actor_id','client_id','source_context_id','goal','description','explanation','state','revision','event_revision','related_evaluated','completed_receipt_id','created_at','updated_at','related_assessment','pending_enrichment','record_expansion']);
export function responseView(result:Record<string,unknown>):Record<string,unknown> {
 const filtered=Object.fromEntries(Object.entries(result).filter(([k])=>responseKeys.has(k)));
 // Same fixed outputs can appear through several historical work updates.
 // Distinct roles/facts and original history remain intact.
 if(Array.isArray(filtered['fixed_refs'])){
  const unique=new Map<string,unknown>();
  for(const ref of filtered['fixed_refs']){const key=canonical(ref);if(!unique.has(key))unique.set(key,ref);}
  filtered['fixed_refs']=[...unique.values()];
 }

 for(const [name,allowed] of [['project',projectKeys],['work_item',workKeys]] as const){const value=filtered[name];if(value&&typeof value==='object'&&!Array.isArray(value))filtered[name]=Object.fromEntries(Object.entries(value).filter(([key])=>allowed.has(key)));}
 return filtered;
}
export function createServer(config:V8Config) {
 const app=server('v8'),pool=config.pool??database(config.databaseUrl);
 installUsage(app,pool,{...(config.usagePool?{pool:config.usagePool}:{}),...(config.usageSpoolDirectory?{directory:config.usageSpoolDirectory}:{})});installChanges(app,pool,config);if(!config.pool)app.addHook('onClose',async()=>pool.end());
 async function call(request:import('fastify').FastifyRequest,name:string,action:string,body:Record<string,unknown>,resource?:Record<string,unknown>){
  const mutationNames=new Set(['project_create','project_convert','work_open','work_commit','work_save','adoption_set','context_prepare','context_materialize','handoff_record','handoff_accept','impact_judge','experience_publish','experience_feedback']);
  if(mutationNames.has(name)&&body['idempotency_key']===undefined){const header=request.headers['idempotency-key'];if(header!==undefined&&(typeof header!=='string'||header.length<1||header.length>200))throw new DomainError('invalid_idempotency_key');body['idempotency_key']=header??randomUUID();}
  const auth=await decide(config,bearer(request),action,{...body,...resource,project_id:body['project_id']},body,sourceFromRequest(request));
  const result=responseView(await sqlFunction<Record<string,unknown>>(pool,'v8.'+name,[auth.handle,digest(body),canonical(body)]));if(body['idempotency_key']!==undefined)result['idempotency_key']=body['idempotency_key'];return result;
 }
 installDiscovery(app,pool,config,call);installExpansion(app,call);installGovernance(app,call);installGovernanceInbox(app,call);
 for(const [path,name,action,schema] of schemas)app.post(path,async(request,reply)=>{const parsed=schema.safeParse(request.body);if(!parsed.success)throw new DomainError('invalid_input');const result=await call(request,name,action,parsed.data as Record<string,unknown>);if(result['state']==='conflict')reply.code(409);if(name==='work_read'&&result['read_receipt_id'])reply.raw.once('finish',()=>{void call(request,'work_mark_read','v8.work.read',{project_id:(parsed.data as Record<string,unknown>)['project_id'],read_receipt_id:result['read_receipt_id'],state:'sent'}).catch(()=>request.log.warn({error_code:'work_read_receipt_pending'},'delivery evidence pending'));});return result;});
 app.get('/v2/work-items/:id',async(request,reply)=>{const id=uuid.safeParse((request.params as {id?:string}).id);const query=z.object({project_id:uuid}).strict().safeParse(request.query);if(!id.success||!query.success)throw new DomainError('invalid_input');const body={project_id:query.data.project_id,work_item_id:id.data};const result=await call(request,'work_read','v8.work.read',body);reply.raw.once('finish',()=>{void call(request,'work_mark_read','v8.work.read',{project_id:body.project_id,read_receipt_id:result['read_receipt_id'],state:'sent'}).catch(()=>request.log.warn({error_code:'work_read_receipt_pending'},'delivery evidence pending'));});return result;});
 app.post('/v2/projects',async request=>{
  const schema=z.object({idempotency_key:key.optional(),kind:z.enum(['project','dialogue']).default('project'),visibility:z.enum(['personal','team']).default('personal'),title:z.string().max(500).default('未命名工作范围'),manager_id:uuid.optional()}).strict();const parsed=schema.safeParse(request.body);if(!parsed.success)throw new DomainError('invalid_input');
  const url=new URL('/whoami',config.hufuUrl);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('local Hufu required');
  const who=await fetch(url,{headers:{authorization:'Bearer '+bearer(request)},signal:AbortSignal.timeout(5000)});if(!who.ok)throw new DomainError('unauthenticated',401);const identity=await who.json() as Record<string,unknown>;
  const owner=z.uuid().safeParse(identity['actor_id']),organization=z.uuid().safeParse(identity['organization_id']);if(!owner.success||!organization.success)throw new DomainError('identity_unavailable',503,true);
  const header=request.headers['idempotency-key'];if(header!==undefined&&(typeof header!=='string'||header.length<1||header.length>200))throw new DomainError('invalid_idempotency_key');const idempotency_key=parsed.data.idempotency_key??header??randomUUID();const hash=sha256('v8.project\n'+owner.data+'\n'+idempotency_key);const project_id=hash.slice(0,8)+'-'+hash.slice(8,12)+'-4'+hash.slice(13,16)+'-a'+hash.slice(17,20)+'-'+hash.slice(20,32);
  const body={...parsed.data,idempotency_key,project_id,organization_id:organization.data,owner_id:owner.data};return call(request,'project_create','v8.project.create',body,{project_id:body.project_id,organization_id:organization.data,owner_id:owner.data});
 });
 app.post('/v2/projects/manager-candidates',async request=>{if(!z.object({}).strict().safeParse(request.body??{}).success)throw new DomainError('invalid_input');const url=new URL('/whoami',config.hufuUrl);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('local Hufu required');const who=await fetch(url,{headers:{authorization:'Bearer '+bearer(request)},signal:AbortSignal.timeout(5000)});if(!who.ok)throw new DomainError('unauthenticated',401);const identity=await who.json() as Record<string,unknown>;const owner=uuid.safeParse(identity['actor_id']),organization=uuid.safeParse(identity['organization_id']);if(!owner.success||!organization.success)throw new DomainError('identity_unavailable',503,true);return call(request,'manager_candidates','v8.project.create',{project_id:randomUUID(),owner_id:owner.data,organization_id:organization.data});});
 app.post('/v2/contexts/:id/materialize',async(request,reply)=>{const parsed=z.object({...mutation,mode:z.enum(['complete','clipped']).default('clipped')}).strict().safeParse(request.body);const id=uuid.safeParse((request.params as {id?:string}).id);if(!parsed.success||!id.success)throw new DomainError('invalid_input');const result=await call(request,'context_materialize','v8.context.materialize',{...parsed.data,context_id:id.data});if(result['state']==='rejected')reply.code(409);return result;});
 return app;
}

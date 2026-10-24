import {attachKnowledgeFollowup} from './knowledge-followup.js';
import {projectCreateSchema,materializeBodySchema,materializeIdSchema} from './core-contracts.js';
import {readProjectIdentity} from './project-identity.js';
import {uuid,base,mutation,revision,related,json,fixedRef,schemas} from './core-contracts.js';
export {fixedRef} from './core-contracts.js';
import {installProjectFeedback} from './project-feedback.mjs';
import {installTaskPoints,installMemberWork} from './task-points.mjs';
import {normalizeWorkJudgment,attachWorkJudgment,workJudgmentPolicy,WorkJudgmentError} from './work-judgment.js';
import {attachRelationProperties, normalizeRelationProperties, RelationPropertyError} from './relation-properties.js';
import{registerLegacySelfWork}from'./legacy-self-work.js';
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
// Explicit response fields suppress unexpected SQL metadata and any future secret columns.
const responseKeys=new Set(['next_scan_cursor','unchanged_ids','project_attributes','operation_id','state','domain_revision','fixed_refs','receipt','coverage','retryable','error_code','retained_state','next_step','project','work_item','work_item_id','short_no','read_receipt_id','relations','results','adoptions','items','next_cursor','context_id','manifest_hash','expires_at','view_id','returned_view','handoff_id','experience_id','feedback_id','adoption_id','adoption_revision','source_context_id','project_id','idempotency_key','completion_claim','related_assessment','pending_enrichment','update_id','update_hash','write_mode','updates','warnings','delta','candidate','judgment_id','judgment_hash','use_evidence','artifact_availability','manifest_canonical_text','canonical_format','returned_count','returned_view_hash','expansion','statement_id','kind','document_hash','sha256','size','path','bytes_base64','text','utf8_state','chunk_sha256','range','next_offset','appearance','request_usage','measured_at','history','schema_change','unknown_scope','response_path_budget_truncated','statistics_are_not_schema_columns','current_summary','brief_semantics','summary_semantics','judgment','work_revision','statement_sha256','reason_truncated','work_state','completion_applied']);
const projectKeys=new Set(['properties','governance','responsibility','responsible_actor_id','id','organization_id','kind','visibility','owner_id','manager_id','title','revision','epoch','event_revision','state','created_at']);
const workKeys=new Set(['id','short_no','project_id','actor_id','client_id','source_context_id','goal','description','explanation','state','revision','event_revision','related_evaluated','completed_receipt_id','created_at','updated_at','related_assessment','pending_enrichment','record_expansion']);
responseKeys.add('handling_state');responseKeys.add('revision');responseKeys.add('effect');responseKeys.add('recent_work');responseKeys.add('activity_coverage');
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
 return attachRelationProperties(filtered);
}
export function createServer(config:V8Config) {
 const app=server('v8'),pool=config.pool??database(config.databaseUrl);
 app.get('/v2/work-items/judgment-policy',async()=>workJudgmentPolicy);
 app.post('/v2/work-items/judgment',async request=>{const body=z.object({...base,work_item_id:uuid,expected_revision:revision}).strict().parse(request.body);return call(request,'work_judgment_read','v8.work.read',body);});
 installUsage(app,pool,{...(config.usagePool?{pool:config.usagePool}:{}),...(config.usageSpoolDirectory?{directory:config.usageSpoolDirectory}:{})});installChanges(app,pool,config);
installProjectFeedback(app,pool);installTaskPoints(app,pool);installMemberWork(app,pool,call);registerLegacySelfWork(app,pool);if(!config.pool)app.addHook('onClose',async()=>pool.end());
 async function call(request:import('fastify').FastifyRequest,name:string,action:string,body:Record<string,unknown>,resource?:Record<string,unknown>){
  if(name==='work_save'||name==='work_commit'){try{body=normalizeWorkJudgment(body)}catch(e){if(e instanceof WorkJudgmentError)throw new DomainError(e.code);throw e}}
  const mutationNames=new Set(['project_governance_save','project_create','project_convert','work_open','work_commit','work_save','adoption_set','context_prepare','context_materialize','handoff_record','handoff_accept','handoff_progress','impact_judge','experience_publish','experience_feedback']);
  if(mutationNames.has(name)&&body['idempotency_key']===undefined){const header=request.headers['idempotency-key'];if(header!==undefined&&(typeof header!=='string'||header.length<1||header.length>200))throw new DomainError('invalid_idempotency_key');body['idempotency_key']=header??randomUUID();}
  if(name==='handoff_progress'){
   const raw=await sqlFunction<Record<string,unknown>>(pool,'v8.handoff_progress_member',[sha256(bearer(request)),digest(body),canonical(body),sourceFromRequest(request)??null]);
   const result=responseView(raw);result['idempotency_key']=body['idempotency_key'];return result;
  }
  const auth=await decide(config,bearer(request),action,{...body,...resource,project_id:body['project_id']},body,sourceFromRequest(request));
  const raw=await sqlFunction<Record<string,unknown>>(pool,'v8.'+name,[auth.handle,digest(body),canonical(body)]);const result=attachKnowledgeFollowup(attachWorkJudgment(responseView(raw),name,body,raw),name,body);if(body['idempotency_key']!==undefined)result['idempotency_key']=body['idempotency_key'];return result;
 }
 const moveSchema=z.object({...mutation,target_project_id:uuid,work_item_id:uuid,expected_revision:revision,reason:json.optional()}).strict();
 app.post('/v2/work-items/move',async(request,reply)=>{
  const parsed=moveSchema.safeParse(request.body);if(!parsed.success)throw new DomainError('invalid_input');
  const header=request.headers['idempotency-key'];if(header!==undefined&&(typeof header!=='string'||header.length<1||header.length>200))throw new DomainError('invalid_idempotency_key');
  const body={...parsed.data,idempotency_key:parsed.data.idempotency_key??header??randomUUID()};
  const target={project_id:body.target_project_id,idempotency_key:body.idempotency_key};const token=bearer(request),source=sourceFromRequest(request);
  const from=await decide(config,token,'v8.work.commit',body,body,source),to=await decide(config,token,'v8.work.commit',target,target,source);
  const result=responseView(await sqlFunction<Record<string,unknown>>(pool,'v8.work_project_move',[from.handle,to.handle,digest(body),canonical(body),digest(target),canonical(target)]));result['idempotency_key']=body.idempotency_key;
  if(result['state']==='conflict')reply.code(409);return result;
 });
 installDiscovery(app,pool,config,call);installExpansion(app,call);installGovernance(app,call);installGovernanceInbox(app,call);
 for(const [path,name,action,schema] of schemas)app.post(path,async(request,reply)=>{
  const parsed=schema.safeParse(request.body);
  if(!parsed.success)throw new DomainError('invalid_input');
  let body=parsed.data as Record<string,unknown>;
  if(name==='work_save'||name==='work_commit'){
   try{
    body=normalizeRelationProperties(body,value=>{
     const relations=z.array(related).max(100).safeParse(value);
     return relations.success?relations.data:undefined;
    });
   }catch(error){
    if(error instanceof RelationPropertyError)throw new DomainError(error.code);
    throw error;
   }
  }
  const result=await call(request,name,action,body);
  if(result['state']==='conflict')reply.code(409);
  if(name==='work_read'&&result['read_receipt_id'])reply.raw.once('finish',()=>{
   void call(request,'work_mark_read','v8.work.read',{
    project_id:body['project_id'],read_receipt_id:result['read_receipt_id'],state:'sent',
   }).catch(()=>request.log.warn({error_code:'work_read_receipt_pending'},'delivery evidence pending'));
  });
  return result;
 });
 app.get('/v2/work-items/:id',async(request,reply)=>{const id=uuid.safeParse((request.params as {id?:string}).id);const query=z.object({project_id:uuid}).strict().safeParse(request.query);if(!id.success||!query.success)throw new DomainError('invalid_input');const body={project_id:query.data.project_id,work_item_id:id.data};const result=await call(request,'work_read','v8.work.read',body);reply.raw.once('finish',()=>{void call(request,'work_mark_read','v8.work.read',{project_id:body.project_id,read_receipt_id:result['read_receipt_id'],state:'sent'}).catch(()=>request.log.warn({error_code:'work_read_receipt_pending'},'delivery evidence pending'));});return result;});
 app.post('/v2/projects',async request=>{
  const parsed=projectCreateSchema.safeParse(request.body);if(!parsed.success)throw new DomainError('invalid_input');
  const {actor_id:owner,organization_id:organization}=await readProjectIdentity(config.hufuUrl,bearer(request));
  const header=request.headers['idempotency-key'];if(header!==undefined&&(typeof header!=='string'||header.length<1||header.length>200))throw new DomainError('invalid_idempotency_key');const idempotency_key=parsed.data.idempotency_key??header??randomUUID();const hash=sha256('v8.project\n'+owner+'\n'+idempotency_key);const project_id=hash.slice(0,8)+'-'+hash.slice(8,12)+'-4'+hash.slice(13,16)+'-a'+hash.slice(17,20)+'-'+hash.slice(20,32);
  const body={...parsed.data,idempotency_key,project_id,organization_id:organization,owner_id:owner};return call(request,'project_create','v8.project.create',body,{project_id:body.project_id,organization_id:organization,owner_id:owner});
 });
 app.post('/v2/projects/manager-candidates',async request=>{if(!z.object({}).strict().safeParse(request.body??{}).success)throw new DomainError('invalid_input');const {actor_id:owner,organization_id:organization}=await readProjectIdentity(config.hufuUrl,bearer(request));return call(request,'manager_candidates','v8.project.create',{project_id:randomUUID(),owner_id:owner,organization_id:organization});});
 app.post('/v2/contexts/:id/materialize',async(request,reply)=>{const parsed=materializeBodySchema.safeParse(request.body);const id=materializeIdSchema.safeParse((request.params as {id?:string}).id);if(!parsed.success||!id.success)throw new DomainError('invalid_input');const result=await call(request,'context_materialize','v8.context.materialize',{...parsed.data,context_id:id.data});if(result['state']==='rejected')reply.code(409);return result;});
 return app;
}



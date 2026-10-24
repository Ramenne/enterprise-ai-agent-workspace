import {z} from 'zod';
/** Canonical V8 core input contracts. HTTP execution and generated MCP hints derive here. */
export const uuid = z.uuid(), text = z.string().min(1).max(4000), revision=z.number().int().positive();
export const fixedRef=z.object({material_id:uuid,version_id:uuid,sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const key=z.string().min(1).max(200), base={project_id:uuid}, mutation={...base,idempotency_key:key.optional()};
export const json=z.json();
export const reference=z.object({...fixedRef.shape,role:z.string().min(1).max(100).default('result')}).strict();
export const basis=z.object({explanation:json.optional(),work_read_receipt_id:uuid.optional(),use_origin:z.string().max(200).optional(),refs:z.array(z.object({fixed_ref:fixedRef,read_receipt_id:uuid.optional(),use_origin:z.string().max(200).optional()}).catchall(json)).default([])}).catchall(json);
export const related=z.object({work_item_id:uuid,basis:basis.default({refs:[]}),supersedes:uuid.optional(),state:z.enum(['active','withdrawn','corrected']).default('active')}).strict();
export const coverage=z.enum(['raw_export','user_attachment','agent_summary','partial','unknown']);
export const decision=z.object({text:json.optional(),reason_ref:fixedRef.optional()}).catchall(json);
export const contextConfig=z.object({effective_decisions:z.array(decision).default([]),dissenting_views:z.array(decision).default([]),rejected_explanations:z.array(decision).default([]),fixed_refs:z.array(reference).optional(),limitations:z.array(json).default([]),pending_operations:z.array(z.object({operation_id:uuid.optional(),state:z.string().max(100).optional(),next_step:json.optional(),responsible_scope:json.optional()}).catchall(json)).default([]),next_steps:z.array(json).optional(),source_coverage:coverage.default('unknown'),complete:z.boolean().default(false),estimated_tokens:z.number().int().nonnegative().optional(),token_budget:z.number().int().positive().optional(),ttl_seconds:z.number().int().min(30).max(900).default(900),refreshes_context_id:uuid.optional(),judgments:json.optional(),properties:z.record(z.string(),json).optional()}).strict();
export const workFields={...mutation,work_item_id:uuid.optional(),expected_revision:revision.optional(),goal:z.string().max(4000).optional(),summary:z.string().max(8000).optional(),description:z.string().max(8000).optional(),explanation:json.optional(),outputs:z.array(reference).max(100).default([]),related_evaluated:z.boolean().optional(),related_assessment:z.enum(['assessed','partial','unassessed']).optional(),related:z.array(related).max(100).default([]),completion_state:z.enum(['open','in_progress','completed','cancelled']).optional(),properties:z.record(z.string(),json).optional(),execution_claims:json.optional(),context:z.union([z.boolean(),contextConfig]).optional()};
export const governancePatch=z.object({purpose:z.enum(['business','migrated_history','test']).nullable().optional(),lifecycle:z.enum(['active','paused','archive']).nullable().optional(),responsible_actor_id:uuid.nullable().optional(),reason:json.optional(),evidence:json.optional(),uncertainty:json.optional()}).strict();
export const schemas: Array<[string,string,string,z.ZodType]> = [
 ['/v2/projects/convert','project_convert','v8.project.convert',z.object({...mutation,expected_revision:revision,visibility:z.enum(['personal','team','private']),kind:z.enum(['project','dialogue']),manager_id:uuid.optional(),reason:json.optional(),judgment:json.optional()}).strict()],
 ['/v2/projects/governance/save','project_governance_save','v8.project.update',z.object({...mutation,expected_revision:revision,governance:governancePatch}).strict()],
 ['/v2/projects/read','project_read','v8.project.read',z.object(base).strict()],
 ['/v2/work-items/open','work_open','v8.work.open',z.object({...mutation,goal:z.string().max(4000).default('目标尚未说明'),description:z.string().max(8000).default('')}).strict()],
 ['/v2/work-items/save','work_save','v8.work.commit',z.object({...workFields,context:z.union([z.boolean(),contextConfig]).default(false)}).strict()],
 ['/v2/work-items/commit','work_commit','v8.work.commit',z.object({...workFields,work_item_id:uuid}).strict()],
 ['/v2/work-items/history','work_history','v8.work.read',z.object({...base,work_item_id:uuid}).strict()],
 ['/v2/work-items/read','work_read','v8.work.read',z.object({...base,work_item_id:uuid}).strict()],
 ['/v2/work-items/pending-registration','pending_registration','v8.work.read',z.object({...base,limit:z.number().int().min(1).max(100).default(20),cursor:z.number().int().nonnegative().default(0)}).strict()],
 ['/v2/work-items/related-candidates','related_candidates','v8.work.related_candidates',z.object({...base,work_item_id:uuid.optional(),fixed_refs:z.array(fixedRef).max(100).default([]),query:z.string().max(200).default(''),since:z.iso.datetime().optional(),until:z.iso.datetime().optional(),participants:z.array(uuid).max(100).default([]),limit:z.number().int().min(1).max(50).default(10),cursor:z.number().int().nonnegative().default(0)}).strict()],
 ['/v2/adoptions','adoption_set','v8.adoption.set',z.object({...mutation,work_item_id:uuid,expected_work_revision:revision.optional(),expected_adoption_revision:z.number().int().nonnegative().default(0),fixed_ref:fixedRef,role:z.string().min(1).max(100).default('adopted'),reason:json.optional(),judgment:json.optional(),use_origin:z.string().max(200).optional(),read_receipt_id:uuid.optional()}).strict()],
 ['/v2/contexts/prepare','context_prepare','v8.context.prepare',z.object({...contextConfig.shape,...mutation,work_item_id:uuid,expected_work_revision:revision.optional()}).strict()],
 ['/v2/handoffs','handoff_record','v8.handoff.record',z.object({...mutation,work_item_id:uuid,context_id:uuid.optional(),to_actor_id:uuid.optional(),rationale:z.string().max(4000).optional(),next_actions:z.array(json).default([]),context:contextConfig.optional()}).strict()],
 ['/v2/handoffs/progress','handoff_progress','v8.handoff.record',z.object({...mutation,handoff_id:uuid,expected_revision:revision,handling_state:z.enum(['in_progress','needs_information','waiting_external','delivered','confirmed','declined','withdrawn']),summary:z.string().max(8000).optional(),outputs:z.array(reference).max(100).default([]),limitations:z.array(json).default([])}).strict()],
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

// Domain-owned contracts for discovery, expansion and path-based endpoints.
const search={query:z.string().max(200).default(''),limit:z.number().int().min(1).max(100).default(20),cursor:z.uuid().optional()};
export const projectSearchSchema=z.object(search).strict();
export const workSearchSchema=z.object({project_id:z.uuid(),...search}).strict();
export const projectCreateSchema=z.object({idempotency_key:key.optional(),kind:z.enum(['project','dialogue']).default('project'),visibility:z.enum(['personal','team']).default('personal'),title:z.string().max(500).default('未命名工作范围'),manager_id:uuid.optional()}).strict();
export const materializeBodySchema=z.object({...mutation,mode:z.enum(['complete','clipped']).default('clipped')}).strict();
export const materializeIdSchema=uuid;
export const governanceSchema=z.object({project_id:z.uuid(),work_item_id:z.uuid().optional(),mode:z.enum(['self','project']).default('self'),dynamic_containers:z.array(z.string().min(1).max(240)).max(20).default([]),window_start:z.iso.datetime().optional(),window_end:z.iso.datetime().optional(),max_objects:z.number().int().min(1).max(200).default(100),max_requests:z.number().int().min(1).max(500).default(200),max_paths:z.number().int().min(1).max(200).default(200)}).strict();
const path=z.array(z.string().max(256)).max(20).optional();
const kind=z.enum(['work_update','work_snapshot','impact_judgment','context_manifest','context_view','work_relation','work_view']);
export const expansionContracts:Array<[string,string,z.ZodType]>=[
  ['/v2/work-items/history/page','work_history_page',z.object({...base,work_item_id:uuid,kind:z.enum(['updates','snapshots','impact']).default('updates'),cursor:uuid.optional(),limit:z.number().int().min(1).max(100).default(20)}).strict()],
  ['/v2/statements/read-chunk','statement_read_chunk',z.object({...base,kind,statement_id:uuid,path,offset:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(32768).default(16384)}).strict()],
  ['/v2/contexts/views/page','context_view_page',z.object({...base,view_id:uuid,path,cursor:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(100).default(20)}).strict()]
];
export const supplementalTransportContracts:Array<[string,z.ZodType]>=[
 ...expansionContracts.map(([path,_name,schema]):[string,z.ZodType]=>[path,schema]),
 ['/v2/projects/search',projectSearchSchema],['/v2/work-items/search',workSearchSchema],
 ['/v2/projects',projectCreateSchema],['/v2/governance/fields',governanceSchema],
 // Protocol adapter moves context_id into the HTTP path; both fields derive here.
 ['/v2/contexts/:context_id/materialize',materializeBodySchema.extend({context_id:materializeIdSchema})]
];

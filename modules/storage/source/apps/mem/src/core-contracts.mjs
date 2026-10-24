import {z} from 'zod';
const uuid = z.uuid();
const fixedRef = z.object({ material_id: uuid, version_id: uuid, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const base = { project_id: uuid };
const mutation = { ...base, idempotency_key: z.string().min(1).max(200) };
const upload = z.object({ ...base, idempotency_key: z.string().min(1).max(200), material_id: uuid.optional(), expected_version_id: uuid.nullable().optional(), expected_revision: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative(), logical_path: z.string().min(1).max(1024), origin_kind: z.enum(['member_submission', 'service_generated', 'agent_processed']).optional(), producer: z.string().max(200).optional(), properties: z.record(z.string(), z.unknown()).optional() }).strict();
export const coreRoutes = [
        ['/v2/uploads', 'begin_upload', 'mem.upload', upload],
        ['/v2/uploads/rebase', 'rebase_upload', 'mem.upload', z.object({ ...mutation, operation_id: uuid, expected_revision: z.number().int().nonnegative(), expected_version_id: uuid.nullable() }).strict()],
        ['/v2/material-enumerations', 'enumerate', 'mem.read', z.object(base).strict()],
        ['/v2/material-enumerations/page', 'enumeration_page', 'mem.read', z.object({ ...base, snapshot_id: uuid, cursor: z.number().int().nonnegative(), limit: z.number().int().min(1).max(500).optional() }).strict()],
        ['/v2/operations/query', 'operation', 'mem.read', z.object({ ...base, operation_id: uuid }).strict()],
        ['/v2/collections', 'manage_collection', 'mem.write', z.object({ ...mutation, collection_id: uuid.optional(), expected_revision: z.number().int().nonnegative().optional(), name: z.string().min(1).max(500) }).strict()],
        ['/v2/materials/metadata', 'patch_metadata', 'mem.write', z.object({ ...mutation, material_id: uuid, expected_revision: z.number().int().nonnegative(), properties: z.record(z.string(), z.unknown()).optional(), collection_id: uuid.nullable().optional() }).strict()],
        ['/v2/placements/patch', 'patch_placement', 'mem.write', z.object({ ...mutation, placement_id: uuid, expected_revision: z.number().int().nonnegative(), logical_path: z.string().min(1).max(1024) }).strict()],
        ['/v2/materials/trash', 'trash_material', 'mem.delete', z.object({ ...mutation, material_id: uuid, expected_revision: z.number().int().nonnegative(), restore: z.boolean().optional() }).strict()],
        ['/v2/materials/restore-content', 'restore_content', 'mem.write', z.object({ ...mutation, material_id: uuid, version_id: uuid, expected_revision: z.number().int().nonnegative() }).strict()],
        ['/v2/processing-runs/retry', 'retry_processing', 'mem.process', z.object({ ...base, run_id: uuid, expected_attempt: z.number().int().positive() }).strict()],
        ['/v2/archive-callback/copy-source','archive_copy_source','mem.process',z.object({...base,idempotency_key:z.string().min(1).max(200),inputs:z.array(fixedRef).length(1),outputs:z.array(fixedRef).length(1)}).strict()],
 ['/v2/processing-runs/finish', 'finish_processing', 'mem.process', z.object({ ...base, run_id: uuid, fencing_token: uuid, attempt: z.number().int().positive(), outputs: z.array(fixedRef).min(1).max(100), output_kind: z.enum(['transcript', 'experience', 'skill', 'context', 'summary', 'other']) }).strict()],
        ['/v2/materials/index-text', 'index_text', 'mem.process', z.object({ ...base, version_id: uuid, sha256: z.string().regex(/^[a-f0-9]{64}$/), text: z.string().max(500000), coverage: z.enum(['complete', 'partial', 'unknown']) }).strict()],
        ['/v2/disclosures', 'disclose_manifest', 'mem.share', z.object({ ...mutation, version_id: uuid, output_hash: z.string().regex(/^[a-f0-9]{64}$/), actual_source_closure: z.array(uuid).max(1000), audience_project_id: uuid, excluded_content: z.array(z.string()), scope: z.string().min(1), reshare_conditions: z.string().min(1), reason: z.string().min(1), continued_source_access: z.enum(['required', 'not_required']) }).strict()],
        ['/v2/disclosures/revoke', 'revoke_disclosure', 'mem.share', z.object({ ...mutation, disclosure_id: uuid }).strict()],
        ['/v2/sources/invalidate', 'invalidate_source', 'mem.correct', z.object({ ...mutation, version_id: uuid, reason: z.string().min(1).max(2000) }).strict()],
        ['/v2/read-receipts', 'record_read', 'mem.read', z.object({ ...base, read_receipt_id: uuid, state: z.enum(['acknowledged']) }).strict()]
    ];
export const publishSchema=z.object({ ...base, reason: z.string().max(500).optional(), attempt: z.number().int().positive().optional(), fencing_token: uuid.optional() }).strict();
const item=z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('metadata'), material_id: uuid, expected_revision: z.number().int().nonnegative(), properties: z.record(z.string(), z.unknown()).optional(), collection_id: uuid.nullable().optional() }).strict(),
            z.object({ kind: z.literal('placement'), placement_id: uuid, expected_revision: z.number().int().nonnegative(), logical_path: z.string().min(1).max(1024) }).strict(),
            z.object({ kind: z.literal('trash'), material_id: uuid, expected_revision: z.number().int().nonnegative(), restore: z.boolean().optional() }).strict(),
            z.object({ kind: z.literal('restore_content'), material_id: uuid, version_id: uuid, expected_revision: z.number().int().nonnegative() }).strict()
        ]);
export const batchSchema=z.object({ ...mutation, items: z.array(item).min(1).max(100) }).strict();
export const offlinePrepareSchema=z.object(base).strict();
export const offlinePageSchema=z.object({ ...base, snapshot_id: uuid, cursor: z.number().int().nonnegative(), limit: z.number().int().min(1).max(20).optional() }).strict();
export const fixedReferenceSchema=z.object({ ...base, material_id: uuid, version_id: uuid }).strict();
export const operationIdSchema=uuid;
export const coreInputContracts=[...coreRoutes.filter(([path])=>!['/v2/disclosures','/v2/disclosures/revoke'].includes(path)).map(([path,_name,_action,schema])=>[path,schema]),
['/v2/uploads/:operation_id/publish',publishSchema.extend({operation_id:operationIdSchema})],['/v2/material-batches',batchSchema],['/v2/offline-exports',offlinePrepareSchema],['/v2/offline-exports/page',offlinePageSchema],['/v2/materials/fixed-reference',fixedReferenceSchema]];


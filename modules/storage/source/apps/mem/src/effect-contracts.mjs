import {z} from 'zod';
// One Mem owner for fixed-target effects; handlers and transport publication share these declarations.
export const moveScopeSchema = z.object({ project_id: z.uuid(), material_id: z.uuid(), target_project_id: z.uuid(), placement_id: z.uuid(), expected_scope_revision: z.number().int().nonnegative().optional(), expected_content_revision: z.number().int().nonnegative().optional(), expected_version_id: z.uuid().nullable().optional(), expected_metadata_revision: z.number().int().nonnegative().optional(), expected_placement_revision: z.number().int().positive().optional(), expected_target_project_revision: z.number().int().positive().optional(), target_collection_id: z.uuid().nullable().optional(), target_area_id: z.uuid().nullable().optional(), logical_path: z.string().min(1).max(1024).optional(), idempotency_key: z.string().min(1).max(200), mode: z.enum(['execute', 'proposal']).optional(), judgment: z.record(z.string(), z.unknown()).optional() }).strict();
    const gcScope = { project_id: z.uuid() };
    const gcPlan = z.object({ ...gcScope, operation_id: z.uuid().optional(), material_id: z.uuid().optional(), target_version_id: z.uuid().optional(), idempotency_key: z.string().min(1).max(200), judgment: z.record(z.string(), z.unknown()).optional() }).strict().refine(b => Boolean(b.operation_id) !== Boolean(b.material_id) && (!b.target_version_id || Boolean(b.material_id)));
    const gcExisting = z.object({ ...gcScope, plan_id: z.uuid() }).strict();
export const gcCommands = [
        ['plan', 'gc_plan', 'mem.delete', gcPlan], ['scan', 'gc_scan', 'mem.delete', gcExisting],
        ['retry', 'gc_retry', 'mem.destroy', gcExisting.extend({ irreversible_confirmed: z.literal(true) })],
        ['destroy', 'gc_destroy', 'mem.destroy', gcExisting.extend({ irreversible_confirmed: z.literal(true) })],
        ['status', 'gc_status', 'mem.delete', gcExisting],
        ['read-lease', 'gc_read_lease', 'mem.read', z.object({ ...gcScope, material_id: z.uuid(), version_id: z.uuid(), read_receipt_id: z.uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), ttl_seconds: z.number().int().min(5).max(900).optional(), command: z.enum(['renew', 'release']) }).strict()]
];
const fixed = z.object({ provider: z.literal('s3-compatible'), bucket: z.string().min(1).max(200), key: z.string().regex(/^final\/[0-9a-f-]{36}$/i), version_id: z.string().min(1).max(512).refine(x => !['null', 'undefined'].includes(x)) }).strict();
const sourceRef = z.object({ project_id: z.uuid(), material_id: z.uuid(), version_id: z.uuid() }).strict();
const base = { project_id: z.uuid(), material_id: z.uuid(), version_id: z.uuid(), idempotency_key: z.string().min(1).max(200), judgment: z.record(z.string(), z.unknown()).optional() };
export const objectSchemas={probe:z.object(base).strict(),import_copy:z.object({ ...base, fixed_copy: fixed.optional(), source_ref: sourceRef.optional() }).strict().refine(x => Boolean(x.fixed_copy) !== Boolean(x.source_ref))};
const compensationScope = { project_id: z.uuid(), material_id: z.uuid().optional() };
export const compensationSchemas={plan:z.object({ ...compensationScope, operation_id: z.uuid() }).strict(),apply:z.object({ ...compensationScope, idempotency_key: z.string().min(1).max(200), choices: z.array(z.object({ operation_id: z.uuid(), action: z.enum(['mem.write', 'mem.delete']), material_id: z.uuid(), effect_ids: z.array(z.uuid()).min(1).max(100), judgment: z.record(z.string(), z.unknown()).optional() }).strict()).min(1).max(100) }).strict()};
export const effectInputContracts=[...gcCommands.map(([path,_name,_action,schema])=>['/v2/materials/gc/'+path,schema]),['/v2/materials/move-scope',moveScopeSchema],['/v2/objects/probe',objectSchemas.probe],['/v2/objects/repair',objectSchemas.import_copy],['/v2/compensations/plan',compensationSchemas.plan],['/v2/compensations/apply',compensationSchemas.apply]];

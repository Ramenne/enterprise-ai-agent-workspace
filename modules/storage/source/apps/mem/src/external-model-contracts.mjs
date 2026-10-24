import {z} from 'zod';
import {coreRoutes} from './core-contracts.mjs';
const uuid = z.uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/), target = z.string().min(1).max(200);
const fixed = z.object({ material_id: uuid, version_id: uuid, sha256: hash }).strict();
export const asrPrepareSchema = z.object({ project_id: uuid, input: fixed, provider_target_id: target, parameters: z.record(z.string(), z.unknown()).default({}), idempotency_key: z.string().min(1).max(200).optional(), declaration: z.record(z.string(), z.unknown()).default({}), reuse: z.boolean().default(false) }).strict();
export const asrJobSchema = z.object({ project_id: uuid, job_id: uuid.optional(), run_id: uuid.optional(), provider_target_id: target.optional(), usage: z.enum(['continuation', 'source']).optional(), idempotency_key: z.string().min(1).max(200).optional() }).strict().refine(b => Boolean(b.job_id || b.run_id) && (!b.job_id || !b.run_id || b.job_id === b.run_id));
const selector = z.object({ version: z.literal(1), kind: z.enum(['project', 'set']), materials: z.array(uuid).optional(), collections: z.array(uuid).optional(), areas: z.array(uuid).optional() }).strict();
export const externalReleaseSchema = z.object({ project_id: uuid, provider_target_id: target, resource_selector: selector, fixed_constraints: z.array(fixed).max(1000).default([]), purpose: z.string().max(200).optional(), until_revoked: z.boolean().default(false), expires_at: z.iso.datetime().optional(), reason: z.unknown().optional(), evidence: z.unknown().optional(), idempotency_key: z.string().min(1).max(200) }).strict();
export const externalRevokeSchema = z.object({ project_id: uuid, release_id: uuid, idempotency_key: z.string().min(1).max(200) }).strict();

export const externalModelTypes={uuid,hash,fixed,target};
// Presentation alternatives only; the HTTP handler retains its original branch selector.
const ordinaryDisclosure=path=>coreRoutes.find(([p])=>p===path)[3];
export const externalInputContracts=[
 ['/v2/asr/prepare',asrPrepareSchema],['/v2/asr/status',asrJobSchema],['/v2/asr/poll',asrJobSchema],
 ['/v2/asr/start',z.union([asrPrepareSchema,asrJobSchema])],
 ['/v2/disclosures',z.union([ordinaryDisclosure('/v2/disclosures'),externalReleaseSchema])],
 ['/v2/disclosures/revoke',z.union([ordinaryDisclosure('/v2/disclosures/revoke'),externalRevokeSchema])]
];

import {z} from 'zod';
const uuid=z.uuid(),key=z.string().min(1).max(200),reason=z.string().max(4000).optional();
export const projectPrivacySchemas={
 apply:z.object({project_id:uuid,grantee_id:uuid.optional(),purpose:reason,expires_at:z.iso.datetime({offset:true}).nullable().optional(),until_revoked:z.boolean().optional(),idempotency_key:key}).strict(),
 requests:z.object({request_id:uuid.optional(),project_id:uuid.optional(),view:z.enum(['mine','owner','supervisor','all_visible']).optional(),limit:z.number().int().min(1).max(100).optional(),cursor:uuid.optional()}).strict(),
 decide:z.object({request_id:uuid,expected_revision:z.number().int().positive(),decision:z.enum(['approve','reject','withdraw']),leg:z.enum(['owner','supervisor']).optional(),reason,idempotency_key:key}).strict(),
 revoke:z.object({request_id:uuid,expected_revision:z.number().int().positive(),reason,idempotency_key:key}).strict()
};

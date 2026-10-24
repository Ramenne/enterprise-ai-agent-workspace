/** Use current Hufu/MCP's already locked Zod; this module installs no dependency. */
export function vaultInputSchemas(z){const uuid=z.uuid(),selector={entry_id:uuid.optional(),key:z.string().min(1).max(200).optional()},key=z.string().min(1).max(200),time=z.string().min(1).describe('与现有HTTP校验一致的时间字符串，支持UTC及带时区偏移；有效性由领域校验判断'),json=z.json();return{
 directory:z.object({cursor:uuid.optional(),limit:z.number().int().min(1).max(100).default(50),query:z.string().max(200).optional()}).strict(),
 apply:z.object({...selector,idempotency_key:key.optional(),purpose:json.optional(),until_revoked:z.boolean().default(false),expires_at:time.optional()}).strict(),
 applications:z.object({...selector,cursor:uuid.optional(),view:z.enum(['mine','pending','managed']).optional(),state:z.enum(['pending','approved','rejected','withdrawn']).optional()}).strict(),
 decide:z.object({application_id:uuid,expected_revision:z.number().int().positive(),decision:z.enum(['approve','reject']),until_revoked:z.boolean().optional(),expires_at:time.optional(),reason:json.optional(),idempotency_key:key.optional()}).strict(),
 grants:z.object({...selector,cursor:uuid.optional()}).strict(),revoke:z.object({grant_id:uuid,expected_revision:z.number().int().positive()}).strict(),reveal:z.object(selector).strict()
};}

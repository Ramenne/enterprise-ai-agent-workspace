import {z} from 'zod';

// HTTP parses body and params.id separately. The MCP publication describes the
// same fields with operation_id; its existing adapter moves that field to the URL.
export const uploadOperationIdSchema=z.uuid();
export const projectScopeSchema=z.object({project_id:z.uuid()}).strict();
export const uploadControlSchemas={
 'put-ticket':projectScopeSchema,
 'put/status':projectScopeSchema,
 'put/complete':projectScopeSchema,
 'multipart/begin':projectScopeSchema.extend({part_size:z.number().int().min(5242880).max(5368709120)}),
 'multipart/part-ticket':projectScopeSchema.extend({part_number:z.number().int().min(1).max(10000),size:z.number().int().positive()}),
 'multipart/list':projectScopeSchema,
 'multipart/resume':projectScopeSchema,
 'multipart/complete':projectScopeSchema,
 'multipart/abort':projectScopeSchema
};
export const archivePublishSchema=z.object({
 project_id:z.uuid(),expected_project_revision:z.number().int().positive(),expected_owner_id:z.uuid(),
 reason:z.string().max(500).optional(),attempt:z.number().int().positive().optional(),fencing_token:z.uuid().optional()
}).strict();
export const uploadInputContracts=[
 ...Object.entries(uploadControlSchemas).map(([suffix,schema])=>['/v2/uploads/:operation_id/'+suffix,schema.extend({operation_id:uploadOperationIdSchema})]),
 ['/v2/uploads/:operation_id/publish-archive',archivePublishSchema.extend({operation_id:uploadOperationIdSchema})],
 ['/v2/materials/gc-candidates',projectScopeSchema]
];

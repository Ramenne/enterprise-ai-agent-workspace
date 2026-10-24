import {z} from 'zod';
const uuid=z.uuid();
export const urlDestinationSchema=z.object({project_id:uuid,logical_path:z.string().min(1).max(1024).optional(),material_id:uuid.optional(),base_version_id:uuid.optional(),base_revision:z.number().int().nonnegative().optional()}).strict();
const begin=urlDestinationSchema.extend({url:z.string().min(1).max(8192),idempotency_key:z.string().min(1).max(200).optional()}).strict();
const resume=z.object({import_id:uuid,url:z.string().min(1).max(8192).optional(),base_version_id:uuid.optional(),base_revision:z.number().int().nonnegative().optional(),save_as_new:z.boolean().optional(),logical_path:z.string().min(1).max(1024).optional()}).strict();
export const urlImportSchemas={begin,resume,status:z.object({import_id:uuid}).strict()};
export const urlImportRoutes={begin:'/import',resume:'/resume',status:'/status'} as const;

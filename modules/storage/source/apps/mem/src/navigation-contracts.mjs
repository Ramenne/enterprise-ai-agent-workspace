import {z} from 'zod';
const base={ project_id: z.uuid(), material_id: z.uuid() };
export const navigationRoutes=[['/v2/materials/trash-list', 'trash_list', z.object({ project_id: z.uuid(), cursor: z.uuid().nullable().optional(), limit: z.number().int().min(1).max(200).optional() }).strict()], ['/v2/materials/head', 'material_head', z.object(base).strict()], ['/v2/materials/history', 'material_history', z.object({ ...base, cursor: z.uuid().nullable().optional(), limit: z.number().int().min(1).max(200).optional() }).strict()]];
export const navigationInputContracts=navigationRoutes.map(([path,_name,schema])=>[path,schema]);

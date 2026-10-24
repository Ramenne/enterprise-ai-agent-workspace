import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {bearer,DomainError} from '../../../packages/platform/src/http.js';
import {sourceFromRequest} from '../../../packages/platform/src/source.js';
type Call=(token:string,source:unknown,name:string,action:string,body:Record<string,unknown>)=>Promise<Record<string,unknown>>;
export function registerMaterialNavigation(app:FastifyInstance,call:Call):void {
 const base={project_id:z.uuid(),material_id:z.uuid()};
 const routes:Array<[string,string,z.ZodType]>=[['/v2/materials/head','material_head',z.object(base).strict()],['/v2/materials/history','material_history',z.object({...base,cursor:z.uuid().nullable().optional(),limit:z.number().int().min(1).max(200).optional()}).strict()]];
 for(const [path,name,schema]of routes)app.post(path,async(request:FastifyRequest)=>{
  const parsed=schema.safeParse(request.body);if(!parsed.success)throw new DomainError('invalid_input');
  return call(bearer(request),sourceFromRequest(request),name,'mem.read',parsed.data as Record<string,unknown>);
 });
}

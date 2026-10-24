import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {DomainError} from '../../../packages/platform/src/http.js';
const uuid=z.uuid();const base={project_id:uuid};
const path=z.array(z.string().max(256)).max(20).optional();
const kind=z.enum(['work_update','work_snapshot','impact_judgment','context_manifest','context_view','work_relation','work_view']);
type Call=(request:FastifyRequest,name:string,action:string,body:Record<string,unknown>)=>Promise<Record<string,unknown>>;
export function installExpansion(app:FastifyInstance,call:Call){
 const routes:Array<[string,string,z.ZodType]>=[
  ['/v2/work-items/history/page','work_history_page',z.object({...base,work_item_id:uuid,kind:z.enum(['updates','snapshots','impact']).default('updates'),cursor:uuid.optional(),limit:z.number().int().min(1).max(100).default(20)}).strict()],
  ['/v2/statements/read-chunk','statement_read_chunk',z.object({...base,kind,statement_id:uuid,path,offset:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(32768).default(16384)}).strict()],
  ['/v2/contexts/views/page','context_view_page',z.object({...base,view_id:uuid,path,cursor:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(100).default(20)}).strict()]
 ];
 for(const [route,name,schema]of routes)app.post(route,async request=>{
  const result=schema.safeParse(request.body);if(!result.success)throw new DomainError('invalid_input');
  try{return await call(request,name,'v8.work.read',result.data as Record<string,unknown>);}
  catch(error){const code=(error as {code?:string}).code;if(code==='22023')throw new DomainError('invalid_expansion_cursor_path_or_range');if(code==='XX001')throw new DomainError('statement_integrity_mismatch',503,true);throw error;}
 });
}

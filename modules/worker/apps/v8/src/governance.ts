import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {DomainError} from '../../../packages/platform/src/http.js';
type Call=(request:FastifyRequest,name:string,action:string,body:Record<string,unknown>)=>Promise<Record<string,unknown>>;
export function installGovernance(app:FastifyInstance,call:Call){
 const schema=z.object({project_id:z.uuid(),work_item_id:z.uuid().optional(),mode:z.enum(['self','project']).default('self'),dynamic_containers:z.array(z.string().min(1).max(240)).max(20).default([]),window_start:z.iso.datetime().optional(),window_end:z.iso.datetime().optional(),max_objects:z.number().int().min(1).max(200).default(100),max_requests:z.number().int().min(1).max(500).default(200),max_paths:z.number().int().min(1).max(200).default(200)}).strict();
 app.post('/v2/governance/fields',async request=>{const parsed=schema.safeParse(request.body);if(!parsed.success)throw new DomainError('invalid_input');if(parsed.data.window_start&&parsed.data.window_end&&Date.parse(parsed.data.window_end)<=Date.parse(parsed.data.window_start))throw new DomainError('invalid_usage_window');return call(request,'field_governance','v8.work.read',parsed.data);});
}

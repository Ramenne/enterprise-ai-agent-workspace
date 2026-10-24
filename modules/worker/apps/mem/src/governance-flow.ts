import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {bearer,DomainError} from '../../../packages/platform/src/http.js';
import {sourceFromRequest} from '../../../packages/platform/src/source.js';
type Call=(token:string,source:unknown,name:string,action:string,body:Record<string,unknown>)=>Promise<Record<string,unknown>>;
export function registerGovernanceFlow(app:FastifyInstance,call:Call){
 const schema=z.object({project_id:z.uuid(),material_id:z.uuid().optional(),collection_id:z.uuid().optional(),mode:z.enum(['self','project']).default('self'),dynamic_containers:z.array(z.string().min(1).max(240)).max(20).default([]),window_start:z.iso.datetime().optional(),window_end:z.iso.datetime().optional(),max_objects:z.number().int().min(1).max(200).default(100),max_requests:z.number().int().min(1).max(500).default(200),max_paths:z.number().int().min(1).max(200).default(200)}).strict();
 app.post('/v2/governance/fields',async request=>{const parsed=schema.safeParse(request.body);if(!parsed.success)throw new DomainError('invalid_input');if(parsed.data.window_start&&parsed.data.window_end&&Date.parse(parsed.data.window_end)<=Date.parse(parsed.data.window_start))throw new DomainError('invalid_usage_window');return call(bearer(request),sourceFromRequest(request),'field_governance','mem.read',parsed.data);});
}

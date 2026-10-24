import {governanceSchema} from './core-contracts.js';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {DomainError} from '../../../packages/platform/src/http.js';
type Call=(request:FastifyRequest,name:string,action:string,body:Record<string,unknown>)=>Promise<Record<string,unknown>>;
export function installGovernance(app:FastifyInstance,call:Call){
 app.post('/v2/governance/fields',async request=>{const parsed=governanceSchema.safeParse(request.body);if(!parsed.success)throw new DomainError('invalid_input');if(parsed.data.window_start&&parsed.data.window_end&&Date.parse(parsed.data.window_end)<=Date.parse(parsed.data.window_start))throw new DomainError('invalid_usage_window');return call(request,'field_governance','v8.work.read',parsed.data);});
}

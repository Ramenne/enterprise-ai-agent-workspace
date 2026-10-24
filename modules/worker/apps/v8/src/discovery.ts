import type {FastifyInstance,FastifyRequest} from 'fastify';
import type pg from 'pg';
import {z} from 'zod';
import {bearer,DomainError} from '../../../packages/platform/src/http.js';
import {sourceFromRequest} from '../../../packages/platform/src/source.js';
import {sqlFunction} from '../../../packages/platform/src/db.js';
import {canonical,digest} from '../../../packages/platform/src/canonical.js';
import type {DecisionConfig} from '../../../packages/platform/src/decision.js';
const search={query:z.string().max(200).default(''),limit:z.number().int().min(1).max(100).default(20),cursor:z.uuid().optional()};
type DomainCall=(request:FastifyRequest,name:string,action:string,body:Record<string,unknown>)=>Promise<Record<string,unknown>>;
export function installDiscovery(app:FastifyInstance,pool:pg.Pool,config:DecisionConfig,call:DomainCall){
 app.post('/v2/projects/search',async request=>{
  const parsed=z.object(search).strict().safeParse(request.body??{});
  if(!parsed.success)throw new DomainError('invalid_input');
  const body=parsed.data;const url=new URL('/internal/discovery-decision',config.hufuUrl);
  if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('local Hufu required');
  const source=sourceFromRequest(request);
  const token=bearer(request);let response:Response;let decision:{handle?:unknown;error_code?:string};
  try{response=await fetch(url,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','x-hub-service-key':config.serviceKey},body:JSON.stringify({request_digest:digest(body),...(source?{source_context:source}:{})}),signal:AbortSignal.timeout(5000)});decision=await response.json() as typeof decision;}
  catch{throw new DomainError('authorization_unavailable',503,true);}
  if(!response.ok)throw new DomainError(decision.error_code??'authorization_unavailable',response.status,response.status>=500);
  if(typeof decision.handle!=='string'||!z.uuid().safeParse(decision.handle).success)throw new DomainError('authorization_unavailable',503,true);
  return sqlFunction<Record<string,unknown>>(pool,'v8.project_search',[decision.handle,digest(body),canonical(body)]);
 });
 app.post('/v2/work-items/search',async request=>{
  const parsed=z.object({project_id:z.uuid(),...search}).strict().safeParse(request.body);
  if(!parsed.success)throw new DomainError('invalid_input');
  return call(request,'work_search','v8.work.read',parsed.data);
 });
}

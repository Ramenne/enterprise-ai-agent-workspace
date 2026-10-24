import {workspaceCursorCodec} from './catalog-cursor.js';
import {requestAuthorization} from '../../../packages/platform/src/authorization-transport.mjs';
import {projectSearchSchema,workSearchSchema} from './core-contracts.js';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type pg from 'pg';
import {z} from 'zod';
import {bearer,DomainError} from '../../../packages/platform/src/http.js';
import {sourceFromRequest} from '../../../packages/platform/src/source.js';
import {sqlFunction} from '../../../packages/platform/src/db.js';
import {canonical,digest} from '../../../packages/platform/src/canonical.js';
import type {DecisionConfig} from '../../../packages/platform/src/decision.js';
type DomainCall=(request:FastifyRequest,name:string,action:string,body:Record<string,unknown>)=>Promise<Record<string,unknown>>;
export function installDiscovery(app:FastifyInstance,pool:pg.Pool,config:DecisionConfig,call:DomainCall){
 app.post('/v2/projects/search',async request=>{
  const parsed=projectSearchSchema.safeParse(request.body??{});
  if(!parsed.success)throw new DomainError('invalid_input');
  const body=parsed.data,source=sourceFromRequest(request);
  const decision=await requestAuthorization(config,bearer(request),'/internal/discovery-decision',{request_digest:digest(body),...(source?{source_context:source}:{})},DomainError);
  return sqlFunction<Record<string,unknown>>(pool,'v8.project_search',[decision.handle,digest(body),canonical(body)]);
 });
 const catalogCodec=workspaceCursorCodec();
 app.post('/v2/work-items/catalog',async request=>{
  const parsed=z.object({project_id:z.uuid(),cursor:z.uuid().optional(),limit:z.number().int().min(1).max(100).optional(),work_item_ids:z.array(z.uuid()).max(100).optional(),revisions_only:z.boolean().optional(),page_mode:z.boolean().optional(),q:z.string().max(512).optional(),attributes:z.record(z.string().max(200),z.union([z.string().max(2000),z.number(),z.boolean(),z.null()])).optional(),known:z.record(z.uuid(),z.string().regex(/^[a-f0-9]{64}$/)).refine(v=>Object.keys(v).length<=100).optional(),after:z.string().regex(/^[A-Za-z0-9_-]+$/).min(40).max(1400).optional()}).strict().safeParse(request.body);
  if(!parsed.success)throw new DomainError('invalid_input');
  const {after,...query}=parsed.data;const credential=bearer(request);let position;
  if(after)try{position=catalogCodec.open(after,credential,query);}catch{throw new DomainError('workspace_cursor_invalid_refresh',400);}
  const result=await call(request,'work_catalog','v8.work.read',{...query,...(position?{after:position}:{})});
  const {next_scan_cursor,...rest}=result;
  return {...rest,next_scan_cursor:next_scan_cursor?catalogCodec.seal(next_scan_cursor,credential,query):null};
 });
 app.post('/v2/work-items/search',async request=>{
  const parsed=workSearchSchema.safeParse(request.body);
  if(!parsed.success)throw new DomainError('invalid_input');
  return call(request,'work_search','v8.work.read',parsed.data);
 });
}

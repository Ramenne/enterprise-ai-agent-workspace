import type {FastifyInstance} from 'fastify';
import type pg from 'pg';
import {createHash} from 'node:crypto';
import {bearer, sameSecret, DomainError} from '../../../packages/platform/src/http.js';
import {sqlFunction} from '../../../packages/platform/src/db.js';

export function installResourceExecution(app:FastifyInstance,pool:pg.Pool,serviceKey:string):void {
 const executorUrl=new URL(process.env['HUB2_RESOURCE_EXECUTOR_URL']??'http://127.0.0.1:4617/execute');
 if(executorUrl.protocol!=='http:'||executorUrl.hostname!=='127.0.0.1'||executorUrl.pathname!=='/execute'||executorUrl.username||executorUrl.password||executorUrl.search||executorUrl.hash)throw new Error('protected_loopback_executor_required');
 app.post('/v2/resources/execute',{bodyLimit:3*1024*1024},async(request,reply)=>{
  const body=request.body;if(!body||typeof body!=='object'||Array.isArray(body))throw new DomainError('invalid_input');
  const allowed=new Set(['operation','project_id','area_id','environment','path','data_b64','sha256','expected_sha256','idempotency_key','create_parents','region_id','target_id','action','parameters']);
  if(Object.keys(body).some(k=>!allowed.has(k)))throw new DomainError('invalid_input');
  const typed=Object.hasOwn(body,'target_id');
    const typedURL=process.env['HUB2_TYPED_RESOURCE_EXECUTOR_URL'];
    if(typed&&!typedURL)return reply.code(503).send({state:'capability_unavailable',error_code:'typed_resource_executor_unconfigured'});
    const target=typed?new URL(typedURL!):executorUrl;
    if(target.protocol!=='http:'||target.hostname!=='127.0.0.1'||target.pathname!=='/execute'||target.username||target.password||target.search||target.hash)throw new DomainError('protected_loopback_executor_required');
    const token=bearer(request);let response:Response;
  try{response=await fetch(target,{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),
   headers:{authorization:'Bearer '+token,'content-type':'application/json','x-hub-resource-key':serviceKey},body:JSON.stringify(body)});}
  catch{throw new DomainError('resource_executor_unavailable',503,true);}
  reply.code(response.status);const raw=await response.text();
  if(Buffer.byteLength(raw)>3*1024*1024)throw new DomainError('resource_response_limit',502);
  try{return JSON.parse(raw) as Record<string,unknown>;}catch{throw new DomainError('resource_response_invalid',502);}
 });
 app.post('/internal/resource-execution/check',async request=>{
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.ip))throw new DomainError('untrusted_executor',403);
  const supplied=request.headers['x-hub-service-key'];
  if(!sameSecret(typeof supplied==='string'?supplied:undefined,serviceKey))throw new DomainError('untrusted_executor',403);
  const body=request.body;
  if(!body||typeof body!=='object'||Array.isArray(body))throw new DomainError('invalid_input');
  return sqlFunction(pool,Object.hasOwn(body,'target_id')?'authz.resource_execution_check_typed':'authz.resource_execution_check',[createHash('sha256').update(bearer(request)).digest('hex'),body]);
 });
}

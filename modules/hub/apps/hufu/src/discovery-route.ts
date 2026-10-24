import type {FastifyInstance} from 'fastify';
import type pg from 'pg';
import {z} from 'zod';
import {bearer,DomainError,sameSecret} from '../../../packages/platform/src/http.js';
import {sqlFunction} from '../../../packages/platform/src/db.js';
import {normalizeSource} from './source.js';
import {createHash} from 'node:crypto';
/** Only the V8 service may request a credential-bound read-discovery capability. */
export function installDiscoveryDecision(app:FastifyInstance,pool:pg.Pool,serviceKeys:Record<'mem'|'v8'|'worker',string>){
 app.post('/internal/discovery-decision',async request=>{
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.ip))throw new DomainError('forbidden',403);
  const header=request.headers['x-hub-service-key'];
  const matches=(['mem','v8','worker'] as const).filter(domain=>sameSecret(typeof header==='string'?header:undefined,serviceKeys[domain]));
  if(matches.length!==1||matches[0]!=='v8')throw new DomainError('invalid_service_audience',403);
  const parsed=z.object({request_digest:z.string().regex(/^[a-f0-9]{64}$/),source_context:z.unknown().optional()}).strict().safeParse(request.body);
  if(!parsed.success)throw new DomainError('invalid_input');
  return sqlFunction(pool,'authz.issue_discovery_handle',[createHash('sha256').update(bearer(request)).digest('hex'),parsed.data.request_digest,normalizeSource(parsed.data.source_context)]);
 });
}

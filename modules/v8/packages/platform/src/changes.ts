import type pg from 'pg';
import type {FastifyInstance} from 'fastify';
import {changeSchemas} from './change-contracts.js';
import {bearer,DomainError} from './http.js';
import {sourceFromRequest} from './source.js';
import {decide,type DecisionConfig} from './decision.js';
import {canonical,digest} from './canonical.js';
import {transaction} from './db.js';

/** Durable optional change polling; notifications and caches are not access authority. */
export function installChanges(app:FastifyInstance,pool:pg.Pool,config:DecisionConfig){
 for(const snapshot of [true,false])app.post(snapshot?'/v2/changes/snapshot':'/v2/changes',async request=>{
  const schema=snapshot?changeSchemas.snapshot:changeSchemas.poll;
  const parsed=schema.safeParse(request.body);if(!parsed.success)throw new DomainError('invalid_input');
  const body=parsed.data as Record<string,unknown>;const action=config.audience==='mem'?'mem.read':'v8.project.read';
  const handle=await decide(config,bearer(request),action,body,body,sourceFromRequest(request));
  return transaction(pool,async client=>{
   if(snapshot)await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
   const name=snapshot?'evidence.project_snapshot':'evidence.project_changes';
   const result=(await client.query('SELECT '+name+'($1,$2,$3) AS result',[handle.handle,digest(body),canonical(body)])).rows[0]?.['result'];
   return snapshot&&result?{...result,cursor:result.delivery_highwater,continuation:{tool:'hub.changes',arguments:{project_id:body['project_id'],cursor:result.delivery_highwater}}}:result;
  });
 });
}

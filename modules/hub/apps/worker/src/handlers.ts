import type {IOBudget} from '../../../packages/platform/src/machine-budget.js';
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { sqlFunction } from '../../../packages/platform/src/db.js';
import type { ObjectAdapter, FixedObject } from '../../mem/src/objects.js';
import { tokens, tokenRecipe } from '../../mem/src/tokenize.js';
import type { DeterministicHandler, Task } from './worker.js';

export function domainHandlers(pool: pg.Pool, adapter?: ObjectAdapter,budget?:IOBudget): Record<string, DeterministicHandler> {
 const apply = (name: string) => async (client: pg.PoolClient, task: Task, prepared: Record<string, unknown>) =>
  (await client.query('SELECT '+name+'($1,$2,$3'+(name==='mem.worker_index_apply'?', $4':'')+') AS result',
   name==='mem.worker_index_apply'?[task.id,task.attempt,task.fencing_token,prepared]:[task.id,task.attempt,task.fencing_token])).rows[0]['result'] as Record<string, unknown>;
 return {
  index: {
   async prepare(task, context) {
    const scope = await sqlFunction(pool, 'evidence.task_scope', [task.id,task.attempt,task.fencing_token]);
    if (scope['domain']!=='mem') return { state:'not_applicable_to_material_text_index', coverage:'event_has_no_mem_text_version' };
    const source = await sqlFunction(pool, 'mem.worker_index_input', [task.id,task.attempt,task.fencing_token]);
    // A technical extraction limit leaves the fixed version available for a separately authorized extractor.
    if (Number(source['size'])>2_000_000) return {...source,state:'awaiting_extraction'};
    if (!adapter || adapter.mode!=='real') throw new Error('index_object_store_unconfigured');
    const capacity=await budget?.acquire('verify',0,{...(context?.signal?{signal:context.signal}:{})});try{context?.signal.throwIfAborted();const current=await sqlFunction(pool,'mem.worker_index_input',[task.id,task.attempt,task.fencing_token]);if(current['version_id']!==source['version_id']||current['sha256']!==source['sha256'])throw Error('index_current_input_changed');
    const chunks: Buffer[]=[];const hash=createHash('sha256');let size=0;
    const input=await adapter.read(source['object'] as FixedObject);for await (const part of capacity?await capacity.meter(input,false):input) {
     context?.signal.throwIfAborted();size+=part.byteLength;
     if (size>Number(source['size'])) throw new Error('index_object_integrity_mismatch');
     chunks.push(Buffer.from(part));hash.update(part);
    }
    if (size!==Number(source['size']) || hash.digest('hex')!==source['sha256']) throw new Error('index_object_integrity_mismatch');
    let text: string;
    try { text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks)); }
    catch { return {...source,state:'awaiting_extraction'}; }
    if (text.includes('\0') || text.length>500000) return {...source,state:'awaiting_extraction'};
    return {version_id:source['version_id'],sha256:source['sha256'],text,recipe:tokenRecipe,token_text:tokens(text).join(' ')};
    }finally{await capacity?.release();}
   },
   async apply(client,task,prepared) {
    if (prepared['state']==='not_applicable_to_material_text_index') return prepared;
    return apply('mem.worker_index_apply')(client,task,prepared);
   }
  },
  verification_compensation:{prepare:async()=>({}),apply:apply('mem.worker_recover_verification')},
  projection_invalidation:{prepare:async()=>({}),apply:apply('v8.worker_invalidate_views')}
 };
}

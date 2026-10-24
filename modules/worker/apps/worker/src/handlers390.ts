import type {IOBudget} from '../../../packages/platform/src/machine-budget.js';
import type pg from 'pg';
import type {ObjectAdapter} from '../../mem/src/objects.js';
import type {DeterministicHandler} from './worker.js';
import {domainHandlers} from './handlers.js';

/** Existing deterministic handlers, with scoped fixed-input failures kept actionable. */
export function completenessHandlers(pool:pg.Pool,adapter?:ObjectAdapter,budget?:IOBudget):Record<string,DeterministicHandler> {
 const handlers=domainHandlers(pool,adapter,budget),index=handlers['index']!;
 return {...handlers,index:{
  async prepare(task,context) {
   try {return await index.prepare(task,context);}
   catch(error) {
    const status=(error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode;
    if(status===403)throw new Error('index_object_store_forbidden');
    if(status===404)throw new Error('index_object_version_unavailable');
    if(status!==undefined)throw new Error('index_object_store_unavailable');
    throw error;
   }
  },
  apply:index.apply
 }};
}

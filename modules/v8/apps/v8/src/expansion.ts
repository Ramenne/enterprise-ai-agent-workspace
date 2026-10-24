import {expansionContracts} from './core-contracts.js';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {DomainError} from '../../../packages/platform/src/http.js';
type Call=(request:FastifyRequest,name:string,action:string,body:Record<string,unknown>)=>Promise<Record<string,unknown>>;
export function installExpansion(app:FastifyInstance,call:Call){

 for(const [route,name,schema]of expansionContracts)app.post(route,async request=>{
  const result=schema.safeParse(request.body);if(!result.success)throw new DomainError('invalid_input');
  try{return await call(request,name,'v8.work.read',result.data as Record<string,unknown>);}
  catch(error){const code=(error as {code?:string}).code;if(code==='22023')throw new DomainError('invalid_expansion_cursor_path_or_range');if(code==='XX001')throw new DomainError('statement_integrity_mismatch',503,true);throw error;}
 });
}

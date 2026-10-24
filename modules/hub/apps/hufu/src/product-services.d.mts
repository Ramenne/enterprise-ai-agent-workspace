import type {FastifyInstance} from 'fastify';
import type pg from 'pg';
export function serviceInput(path:string,body:unknown):string;
export function installProductServices(app:FastifyInstance,config:{pool:pg.Pool;bearer:(request:any)=>string;credentialKey?:string|undefined}):void;

import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Pool} from 'pg';
export function installTaskPoints(app:FastifyInstance,pool:Pool):void;
export function installMemberWork(app:FastifyInstance,pool:Pool,call:(request:FastifyRequest,name:string,action:string,body:Record<string,unknown>)=>Promise<Record<string,unknown>>):void;

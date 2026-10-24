import type {FastifyInstance} from 'fastify';
import type {z} from 'zod';
export function registerStorageTiers(app:FastifyInstance,config:{z:typeof z;bearer:Function;sourceFromRequest:Function;call:Function;digest:Function;DomainError:Function;provider?:object|undefined;budget?:object|undefined;afterCopyCreated?:(token:string,source:unknown,body:Record<string,unknown>)=>Promise<Record<string,unknown>>}):void;
export function withRestoreRequired<T extends object>(adapter:T,errorClass:Function):T;

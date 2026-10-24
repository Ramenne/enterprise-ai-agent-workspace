import type{FastifyInstance,FastifyRequest}from'fastify';
export function installGovernanceInbox(app:FastifyInstance,call:(request:FastifyRequest,name:string,action:string,body:Record<string,unknown>)=>Promise<Record<string,unknown>>):void;

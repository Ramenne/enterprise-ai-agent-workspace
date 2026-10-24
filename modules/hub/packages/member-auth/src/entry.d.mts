import type {FastifyInstance,FastifyRequest} from 'fastify';import type{StandardMemberAuth}from'./provider.mjs';
export function installStandardEntry(app:FastifyInstance,member:StandardMemberAuth):Promise<void>;
export function authRequest(request:FastifyRequest,baseURL:string):Request;

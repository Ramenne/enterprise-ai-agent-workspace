import type {FastifyInstance} from 'fastify';
import type {z} from 'zod';
import type {ArchiveLifecycle} from './archive-lifecycle.mjs';
export function registerArchiveLifecycle(app:FastifyInstance,config:{z:typeof z;bearer:Function;sourceFromRequest:Function;DomainError:Function;lifecycle:ArchiveLifecycle;call:Function}):void;

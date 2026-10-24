import type pg from 'pg';
import type {FastifyInstance} from 'fastify';
import type {RuntimeConfig} from '../../../platform/src/runtime.js';
export function installVaultNext(app:FastifyInstance,pool:pg.Pool,runtime:RuntimeConfig,installRoutes:Function):Promise<object>;

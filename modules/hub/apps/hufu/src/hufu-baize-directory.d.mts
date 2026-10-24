import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import type {bearer,DomainError} from '../../../packages/platform/src/http.js';
import type {sqlFunction} from '../../../packages/platform/src/db.js';
export function installBaizeDirectory(app:FastifyInstance,dependencies:{pool:Pool;bearer:typeof bearer;sqlFunction:typeof sqlFunction;DomainError:typeof DomainError}):void;

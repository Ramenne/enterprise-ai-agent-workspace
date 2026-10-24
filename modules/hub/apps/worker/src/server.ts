import { server } from '../../../packages/platform/src/http.js';
/** Loopback liveness contains no tasks, private identifiers, or counters. */
export function createServer() { return server('worker'); }

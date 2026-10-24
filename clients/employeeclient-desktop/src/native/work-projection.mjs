import {createQueryProjection} from './query-projection.mjs';
// Compatibility entry: all work callers share the bounded query/sync path.
export function createWorkProjection(deps){const projection=createQueryProjection(deps);return {read:(lease,project,options={})=>projection.read(lease,project,{...options,mode:'work'})};}

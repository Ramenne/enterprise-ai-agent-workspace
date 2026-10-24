export type LifecycleBody=Record<string,unknown>;
export type ArchiveLifecycle=(token:string,source:unknown,body:LifecycleBody,options?:{switchOnly?:boolean;queryOnly?:boolean})=>Promise<LifecycleBody>;
export function createArchiveLifecycle(config:{call:Function;provider:object|undefined;loadKnownCopyEvidence?:Function}):ArchiveLifecycle;
export function withCopyLineage<T extends object>(provider:T):T;

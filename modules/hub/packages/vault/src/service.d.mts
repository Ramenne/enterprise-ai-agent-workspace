import type pg from 'pg';
export interface VaultService {call(name:string,token:string,body:Record<string,unknown>):Promise<Record<string,unknown>>;reveal(token:string,body:Record<string,unknown>):Promise<Record<string,unknown>>;}
export function createVaultService(config:{pool:pg.Pool;secretRuntime:{optionalSecret(ref:string):Promise<Record<string,unknown>|undefined>};secretRefPrefix?:string}):VaultService;

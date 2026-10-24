import { createHash, randomUUID } from 'node:crypto';
import { DomainError } from '../../../packages/platform/src/http.js';
export interface FixedObject { provider: string; bucket: string; key: string; versionId: string; }
export interface ObjectAdapter {
 readonly mode: 'real' | 'test';
 copyToImmutable(stagingKey: string, finalKey: string): Promise<FixedObject>;
 read(object: FixedObject): Promise<AsyncIterable<Uint8Array>>;
}
export type {IOBudget as ObjectIOBudget,BudgetLease as ObjectIOLease} from '../../../packages/platform/src/machine-budget.js';
import type {IOBudget as ObjectIOBudget,BudgetLease as ObjectIOLease} from '../../../packages/platform/src/machine-budget.js';
export async function hashStream(stream: AsyncIterable<Uint8Array>): Promise<{sha256: string; size: number}> {
 const hash=createHash('sha256'); let size=0;
 for await (const part of stream) { hash.update(part);size+=part.byteLength; if (!Number.isSafeInteger(size)) throw new DomainError('object_too_large'); }
 return {sha256:hash.digest('hex'),size};
}
export async function verifyFinal(adapter: ObjectAdapter, staging: string, expected: {sha256:string;size:number},budget?:ObjectIOBudget,beforeEffect?:()=>Promise<void>) {
 if (adapter.mode!=='real') throw new DomainError('real_object_store_required',503);
 let lease:ObjectIOLease|undefined;try{lease=await budget?.acquire('verify',0);}catch{throw new DomainError('capacity_busy_or_unavailable_no_provider_send',503,true);}
 try{await beforeEffect?.();const finalKey='final/'+randomUUID();
 const object=await adapter.copyToImmutable(staging,finalKey);
 if (!object.versionId || ['null','undefined'].includes(object.versionId) || object.key!==finalKey || object.provider==='test-memory') throw new DomainError('fixed_object_version_required',503);
 const input=await adapter.read(object);const verified=await hashStream(lease?await lease.meter(input,false):input);
 if (verified.sha256!==expected.sha256 || verified.size!==expected.size) throw new DomainError('object_integrity_mismatch',409);
 return {...object,...verified};
 }finally{await lease?.release().catch(()=>{process.stderr.write('{"component":"capacity","state":"release_unknown_domain_outcome_preserved"}\n');});}
}
/** Test fixture only. Never valid for formal publication. */
export class TestMemoryAdapter implements ObjectAdapter {
 readonly mode='test' as const; readonly objects=new Map<string,Uint8Array>();
 async copyToImmutable(staging:string,key:string):Promise<FixedObject> { const data=this.objects.get(staging);if(!data)throw new Error('test fixture absent');this.objects.set(key,data.slice());return {provider:'test-memory',bucket:'synthetic',key,versionId:randomUUID()}; }
 async read(object:FixedObject):Promise<AsyncIterable<Uint8Array>> { const bytes=this.objects.get(object.key);if(!bytes)throw new Error('test fixture absent'); return (async function*(){yield bytes.slice();})(); }
}

/** Bounded memory, hash-before-delivery temporary file. No bytes are sent before verification. */
export async function prepareVerifiedRead(adapter:ObjectAdapter,object:FixedObject,expected:{sha256:string;size:number},budget?:ObjectIOBudget,beforeRead?:()=>Promise<void>) {
 const {mkdtemp,rm}=await import('node:fs/promises');const {createWriteStream}=await import('node:fs');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {EventEmitter}=await import('node:events');const {finished}=await import('node:stream/promises');
 let lease:ObjectIOLease|undefined;try{lease=await budget?.acquire('verify',expected.size);}catch{throw new DomainError('capacity_busy_or_unavailable_no_provider_send',503,true);}
 let released=false;const release=async()=>{if(released)return;released=true;await lease?.release().catch(()=>{process.stderr.write('{"component":"capacity","state":"release_unknown_domain_outcome_preserved"}\n');});};
 let directory:string;try{directory=await mkdtemp(join(tmpdir(),'hub2-mem-read-'));}catch(e){await release();throw e;}const path=join(directory,'verified-object');const out=createWriteStream(path,{flags:'wx',mode:0o600});
 const cleanup=async(keepReservation=false)=>{try{await rm(directory,{recursive:true,force:true});}finally{if(!keepReservation)await release();}};const hash=createHash('sha256');let size=0;
 const completion=finished(out);completion.catch(()=>undefined);
 try {
  await beforeRead?.();const input=await adapter.read(object);for await(const part of lease?await lease.meter(input,false):input){size+=part.byteLength;if(size>expected.size)throw new DomainError('object_integrity_mismatch',503,true);hash.update(part);if(!out.write(part))await EventEmitter.once(out,'drain');}
  out.end();await completion;
  if(size!==expected.size||hash.digest('hex')!==expected.sha256)throw new DomainError('object_integrity_mismatch',503,true);
  return {path,cleanup,...(lease?{lease,meterOutput:(input:AsyncIterable<Uint8Array>)=>lease!.meter(input,false)}:{})};
 }catch(error){out.destroy();await completion.catch(()=>undefined);await cleanup();throw error;}
}

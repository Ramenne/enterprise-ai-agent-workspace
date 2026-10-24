import {CONSUMER_REFS,MANAGEMENT_REF,leasePolicy,policyHash,type Consumer} from './policy.js';
import {BrokerError,managementKey,type BrokerErrorCode,type Lease,type StsIssuer} from './tc3.js';
export interface SecretStore {
 readKV(ref:string):Promise<{data:Record<string,unknown>;metadata:{version:number}}>;
 writeKV(ref:string,data:Record<string,unknown>):Promise<{metadata:{version:number}}>;
}
export interface PublishedLease {expires_at:number;issued_at:number;version:number;management_version:number;policy_hash:string;}
export type BrokerState=Partial<Record<Consumer,PublishedLease>>;
export interface BrokerEvent {state:'published'|'retained'|'degraded'|'stopped';domain?:Consumer;code?:BrokerErrorCode;expires_at?:number;version?:number;current_remaining_seconds?:number;external_leases_revoked?:false;}
export interface BrokerConfig {store:SecretStore;issue:StsIssuer;initial?:BrokerState;save?:(state:BrokerState)=>Promise<void>;on_event?:(event:BrokerEvent)=>void;now?:()=>number;retry_delays_ms?:number[];}
export function safeBrokerError(error:unknown):BrokerError {
 if(error instanceof BrokerError)return error;
 const code=(error as {code?:unknown})?.code;
 if(code==='secret_access_denied'||code==='secret_identity_rejected')return new BrokerError('bao_access_denied');
 if(code==='secret_not_found')return new BrokerError('management_unavailable');
 if(code==='secret_client_closed')return new BrokerError('broker_stopped');
 if(error instanceof Error&&error.message==='multipart_scope_configuration_required')return new BrokerError('multipart_scope_configuration_required');
 return new BrokerError('management_unavailable',true);
}
export function createBroker(config:BrokerConfig){
 const now=config.now??(()=>Math.floor(Date.now()/1000));const states:BrokerState={...config.initial};
 const pending:Partial<Record<Consumer,{lease:Lease;management_version:number}>>={};
 let stopped=false;let flight:Promise<void>|undefined;const controller=new AbortController();
 const emit=(event:BrokerEvent)=>{try{config.on_event?.(event);}catch{/* Observation cannot discard a published lease. */}};
 const remaining=(domain:Consumer)=>Math.max(0,(states[domain]?.expires_at??0)-now());
 function assertOpen(){if(stopped)throw new BrokerError('broker_stopped');}
 async function delay(ms:number){await new Promise<void>(resolve=>{let timer:NodeJS.Timeout;const done=()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',done);resolve();};timer=setTimeout(done,ms);controller.signal.addEventListener('abort',done,{once:true});if(controller.signal.aborted)done();});assertOpen();}
 async function retry<T>(action:()=>Promise<T>):Promise<T>{const waits=config.retry_delays_ms??[250,1000];for(let attempt=0;;attempt++){assertOpen();try{return await action();}catch(error){const e=safeBrokerError(error);if(!e.retryable||attempt>=waits.length||stopped)throw e;await delay(waits[attempt]!);}}}
 function snapshot():BrokerState{return Object.fromEntries(Object.entries(states).map(([domain,value])=>[domain,{...value}])) as BrokerState;}
 async function refresh(){
  let manager:Awaited<ReturnType<SecretStore['readKV']>>;
  try{manager=await retry(()=>config.store.readKV(MANAGEMENT_REF));assertOpen();managementKey(manager.data);}
  catch(error){const e=safeBrokerError(error);for(const domain of ['mem','worker'] as const)emit({state:'degraded',domain,code:e.code,current_remaining_seconds:remaining(domain)});return;}
  for(const domain of ['mem','worker'] as const){
   if(stopped)return;
   try{
    const policy=leasePolicy(domain);const fingerprint=policyHash(policy);
    if(remaining(domain)>900&&states[domain]?.management_version===manager.metadata.version&&states[domain]?.policy_hash===fingerprint&&!pending[domain])continue;
    if(pending[domain]&&(pending[domain]!.lease.config.expires_at<=now()+90||pending[domain]!.management_version!==manager.metadata.version||pending[domain]!.lease.policy_hash!==fingerprint))delete pending[domain];
    if(!pending[domain]){const lease=await retry(()=>config.issue(managementKey(manager.data),domain,policy,fingerprint,controller.signal));assertOpen();pending[domain]={lease,management_version:manager.metadata.version};}
    const candidate=pending[domain]!;const receipt=await retry(async()=>{
     assertOpen();if(candidate.lease.config.expires_at<=now()+30)throw new BrokerError('sts_protocol_invalid');
     let result:Awaited<ReturnType<SecretStore['writeKV']>>;
     try{result=await config.store.writeKV(CONSUMER_REFS[domain],candidate.lease.config);}
     catch(error){const e=safeBrokerError(error);throw new BrokerError(e.code==='bao_access_denied'?'bao_access_denied':'bao_write_failed',e.retryable);}
     if(!Number.isSafeInteger(result.metadata?.version)||result.metadata.version<1)throw new BrokerError('bao_write_receipt_invalid',true);
     return result;
    });
    states[domain]={expires_at:candidate.lease.config.expires_at,issued_at:candidate.lease.issued_at,version:receipt.metadata.version,management_version:candidate.management_version,policy_hash:candidate.lease.policy_hash};delete pending[domain];
    // The successful KV receipt is true even if local metadata persistence fails.
    try{await config.save?.(snapshot());}catch{emit({state:'degraded',domain,code:'state_unavailable',current_remaining_seconds:remaining(domain)});}
    emit({state:'published',domain,expires_at:states[domain]!.expires_at,version:receipt.metadata.version});
   }catch(error){const e=safeBrokerError(error);emit({state:remaining(domain)>0?'retained':'degraded',domain,code:e.code,current_remaining_seconds:remaining(domain)});}
  }
 }
 return {
  check():Promise<void>{if(stopped)return Promise.reject(new BrokerError('broker_stopped'));if(!flight)flight=refresh().finally(()=>{flight=undefined;});return flight;},
  snapshot,
  status(){return {stopped,consumers:Object.fromEntries((['mem','worker'] as const).map(domain=>[domain,{last_published_expires_at:states[domain]?.expires_at??null,remaining_seconds:remaining(domain),publication_pending:Boolean(pending[domain]),version:states[domain]?.version??null}]))};},
  async stop(){if(stopped)return;stopped=true;controller.abort();await flight?.catch(()=>{});for(const domain of ['mem','worker'] as const)delete pending[domain];emit({state:'stopped',external_leases_revoked:false});}
 };
}

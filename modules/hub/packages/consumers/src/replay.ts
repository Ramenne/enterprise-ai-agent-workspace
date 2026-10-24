import {createHash} from 'node:crypto';
import {ConsumerError,type PublicApiTransport} from './transport.js';
export interface ReplayEnvelope {contract:'hub-consumer-replay-v1';path:string;logical_key:string;body_key:boolean;body:Record<string,unknown>;fingerprint:string;}
function canonical(value:unknown):string{
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}';
}
function fingerprint(path:string,key:string,bodyKey:boolean,body:unknown){return createHash('sha256').update(canonical({path,logical_key:key,body_key:bodyKey,body})).digest('hex');}
export function prepareReplay(path:string,body:Record<string,unknown>,logicalKey:string,options:{bodyKey?:boolean}={}):ReplayEnvelope{
 if(!path.startsWith('/v2/')||path.startsWith('//')||path.includes('?')||path.includes('#')||path.split('/').includes('..')||logicalKey.length<1||logicalKey.length>200)
  throw new ConsumerError('invalid_replay_input');
 if(body['idempotency_key']!==undefined&&body['idempotency_key']!==logicalKey)throw new ConsumerError('logical_key_conflict');
 const bodyKey=options.bodyKey!==false;
 const exact=JSON.parse(JSON.stringify(bodyKey?{...body,idempotency_key:logicalKey}:body)) as Record<string,unknown>;
 return {contract:'hub-consumer-replay-v1',path,logical_key:logicalKey,body_key:bodyKey,body:exact,fingerprint:fingerprint(path,logicalKey,bodyKey,exact)};
}
export function replayEnvelope(value:unknown):ReplayEnvelope{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new ConsumerError('invalid_replay_input');
 const item=value as Record<string,unknown>;
 if(item['contract']!=='hub-consumer-replay-v1'||typeof item['path']!=='string'||typeof item['logical_key']!=='string'||!item['body']||typeof item['body']!=='object'||Array.isArray(item['body']))throw new ConsumerError('invalid_replay_input');
 if(typeof item['body_key']!=='boolean')throw new ConsumerError('replay_body_key_mode_required');
 const envelope=prepareReplay(item['path'],item['body'] as Record<string,unknown>,item['logical_key'],{bodyKey:item['body_key']});
 if(envelope.fingerprint!==item['fingerprint'])throw new ConsumerError('replay_fingerprint_mismatch');return envelope;
}
export async function replay(api:PublicApiTransport,operation:ReplayEnvelope):Promise<unknown>{
 const exact=replayEnvelope(operation);
 return api.postJson(exact.path,exact.body,{logicalKey:exact.logical_key});
}

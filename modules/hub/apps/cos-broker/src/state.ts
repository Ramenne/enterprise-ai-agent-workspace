import {open,rename,unlink,mkdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {BrokerState,PublishedLease} from './broker.js';
import {BrokerError} from './tc3.js';
/** Receipt metadata only: no management key, STS key, token, header or provider body. */
export function stateFile(path:string){
 return {
  async load():Promise<BrokerState>{
   let file;try{file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);}catch(error){if((error as {code?:string}).code==='ENOENT')return {};throw new BrokerError('state_unavailable');}
   try{const stat=await file.stat();if(!stat.isFile()||(stat.mode&0o077)!==0||stat.size>65536||(process.getuid?.()!==0&&stat.uid!==process.getuid?.()))throw new BrokerError('state_unavailable');
    const parsed:unknown=JSON.parse(await file.readFile('utf8'));if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new BrokerError('state_unavailable');
    const state:BrokerState={};for(const domain of ['mem','worker'] as const){const value=(parsed as Record<string,unknown>)[domain];if(value===undefined)continue;if(!value||typeof value!=='object'||Array.isArray(value))throw new BrokerError('state_unavailable');const v=value as Record<string,unknown>;
     if(!['expires_at','issued_at','version','management_version'].every(key=>Number.isSafeInteger(v[key])&&Number(v[key])>0)||typeof v['policy_hash']!=='string'||!/^[a-f0-9]{64}$/.test(v['policy_hash'])||Number(v['expires_at'])-Number(v['issued_at'])>3900)throw new BrokerError('state_unavailable');
     state[domain]={expires_at:Number(v['expires_at']),issued_at:Number(v['issued_at']),version:Number(v['version']),management_version:Number(v['management_version']),policy_hash:v['policy_hash']} satisfies PublishedLease;
    }return state;
   }catch(error){if(error instanceof BrokerError)throw error;throw new BrokerError('state_unavailable');}finally{await file.close();}
  },
  async save(state:BrokerState):Promise<void>{
   const safe:BrokerState={};for(const domain of ['mem','worker'] as const){const v=state[domain];if(v)safe[domain]={expires_at:v.expires_at,issued_at:v.issued_at,version:v.version,management_version:v.management_version,policy_hash:v.policy_hash};}
   await mkdir(dirname(path),{recursive:true,mode:0o700});const temporary=path+'.'+randomUUID()+'.pending';
   const file=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   try{await file.writeFile(JSON.stringify(safe)+'\n');await file.sync();}finally{await file.close();}
   try{await rename(temporary,path);const directory=await open(dirname(path),constants.O_RDONLY);try{await directory.sync();}finally{await directory.close();}}catch{await unlink(temporary).catch(()=>{});throw new BrokerError('state_unavailable');}
  }
 };
}

import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {ConsumerError,type CredentialProvider,type ConsumerCredential} from './transport.js';

/** Matches the controlled {token:...} client file used by deploy/mcp-call.mjs.
 * Re-reads each request so revocation/rotation isn't hidden by an SDK token cache.
 */
export class FileCredentialProvider implements CredentialProvider {
 constructor(readonly filePath:string){}
 async getCredential():Promise<ConsumerCredential>{
  if(!process.getuid)throw new ConsumerError('posix_controlled_file_required');
  let file;try{file=await open(this.filePath,constants.O_RDONLY|constants.O_NOFOLLOW);}
  catch{throw new ConsumerError('controlled_credential_file_unavailable');}
  try{
   const stat=await file.stat();
   if(!stat.isFile()||(stat.mode&0o077)!==0||stat.uid!==process.getuid()||stat.size>65536)
    throw new ConsumerError('unsafe_credential_file');
   let config:unknown;try{config=JSON.parse(await file.readFile('utf8'));}catch{throw new ConsumerError('invalid_credential_file');}
   if(!config||typeof config!=='object'||Array.isArray(config)||typeof (config as Record<string,unknown>)['token']!=='string')
    throw new ConsumerError('credential_file_token_required');
   return {token:(config as {token:string}).token};
  }finally{await file.close();}
 }
}

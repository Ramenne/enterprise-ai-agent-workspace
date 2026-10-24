import {constants as C} from 'node:fs';
import {open,lstat} from 'node:fs/promises';
import {join} from 'node:path';
/** Caller supplies an existing dedicated service-owned 0700 directory. No keys/tokens are accepted. */
export async function createPrivateJournal(directory, expectedUid) {
 const st=await lstat(directory);
 if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==expectedUid||(st.mode&0o777)!==0o700)throw Error('unsafe_tier_journal');
 return async(operationId,event)=>{
  if(!/^[a-f0-9-]{36}$/i.test(operationId))throw Error('invalid_operation_id');
  const body=JSON.stringify({at:new Date().toISOString(),...event});
  if(body.length>16384||/"(?:secret_access_key|access_key_id|session_token|password|token)"\s*:/.test(body))throw Error('unsafe_journal_event');
  const file=await open(join(directory,operationId+'.jsonl'),C.O_CREAT|C.O_APPEND|C.O_WRONLY|C.O_NOFOLLOW,0o600);
  try {const f=await file.stat();if(!f.isFile()||f.uid!==expectedUid||(f.mode&0o777)!==0o600)throw Error('unsafe_tier_journal');
   await file.writeFile(body+'\n');await file.sync();
  }finally{await file.close();}
  const dir=await open(directory,C.O_RDONLY|C.O_DIRECTORY);try{await dir.sync();}finally{await dir.close();}
 };
}

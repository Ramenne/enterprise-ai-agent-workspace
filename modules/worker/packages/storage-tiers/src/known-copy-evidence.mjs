import {constants as C}from'node:fs';
import {open,lstat}from'node:fs/promises';
import {join}from'node:path';
import {createHash}from'node:crypto';
/** Internal service-only adoption of COPYs made before 733. No user API accepts
 * this evidence object/path. Reads only the bounded private metadata journal. */
export function knownCopyEvidence(directory,uid){return async operation_id=>{
 if(!/^[a-f0-9-]{36}$/i.test(operation_id))throw Error('invalid_operation_id');
 const st=await lstat(directory);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==uid||(st.mode&0o777)!==0o700)throw Error('unsafe_journal_directory');
 const f=await open(join(directory,operation_id+'.jsonl'),C.O_RDONLY|C.O_NOFOLLOW);
 try{
  const before=await f.stat();if(!before.isFile()||before.uid!==uid||(before.mode&0o777)!==0o600||before.size>512*1024)throw Error('unsafe_journal_file');
  const bytes=await f.readFile();const after=await f.stat();if(before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw Error('journal_changed');
  // Ignore an incomplete tail after a process failure, never interpret it as success.
  const rows=bytes.toString('utf8').split('\n').slice(0,-1).map(s=>JSON.parse(s));
  const dispatch=rows.find(r=>r.phase==='copy_dispatch');
  const response=rows.find(r=>r.phase==='copy_response');
  const observed=rows.find(r=>r.phase==='copy_observed')?.receipt;
  if(!dispatch||!response||!observed||JSON.stringify(response.locator)!==JSON.stringify(observed.locator))throw Error('known_copy_receipt_missing');
  return {source_locator:dispatch.source,target_locator:response.locator,size:observed.size,storage_class:observed.storage_class,
   request_id:response.request_id??null,journal_sha256:createHash('sha256').update(bytes).digest('hex'),basis:'known_fixed_COPY_response_and_actual_target_HEAD'};
 }finally{await f.close();}
};}

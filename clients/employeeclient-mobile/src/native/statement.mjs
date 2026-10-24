import {sha256,NativeError} from './client.mjs';
export async function readStatement(client,projectId,item,signal){
 item={...item};signal??=client.signal;const epoch=client.epoch;
 const check=()=>{signal?.throwIfAborted();if(epoch!==client.epoch)throw new NativeError('session_changed',401);};check();
 if(!Number.isSafeInteger(item.size)||item.size<0||item.size>2*1024*1024)throw new NativeError('statement_display_limit');
 const bytes=new Uint8Array(item.size);let offset=0;
 do{
  check();
  const page=await client.rpc('v8.statement.read_chunk',{project_id:projectId,kind:item.kind,statement_id:item.statement_id,offset,limit:32768},undefined,signal);
  check();if(page.sha256!==item.sha256||page.size!==item.size||page.statement_id!==item.statement_id)throw new NativeError('statement_reference_changed');
  if(typeof page.bytes_base64!=='string'||page.bytes_base64.length>4*Math.ceil(Math.min(32768,bytes.length-offset)/3))throw new NativeError('statement_range_invalid');
  const part=Uint8Array.from(atob(page.bytes_base64),c=>c.charCodeAt(0));
  const chunkHash=await sha256(part);check();
  if(page.range?.start!==offset||page.range?.end_exclusive!==offset+part.length||offset+part.length>bytes.length||chunkHash!==page.chunk_sha256)throw new NativeError('statement_range_invalid');
  bytes.set(part,offset);offset+=part.length;
  if(offset<bytes.length&&(page.next_offset!==offset||!part.length))throw new NativeError('statement_incomplete');
 }while(offset<bytes.length);
 check();const digest=await sha256(bytes);check();
 if(digest!==item.sha256)throw new NativeError('statement_integrity_mismatch');
 return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {readStatement} from '../src/native/statement.mjs';
import {sha256} from '../src/native/client.mjs';
test('navigation-only work history expands the exact current fixed statement',async()=>{
 const bytes=new TextEncoder().encode(JSON.stringify({summary:'真实工作记录',outputs:[]})),hash=await sha256(bytes);
 const item={kind:'work_update',statement_id:'id',size:bytes.length,sha256:hash};
 const client={rpc:async()=>({...item,bytes_base64:Buffer.from(bytes).toString('base64'),chunk_sha256:hash,range:{start:0,end_exclusive:bytes.length},next_offset:null})};
 assert.equal((await readStatement(client,'project',item)).summary,'真实工作记录');
 await assert.rejects(readStatement({rpc:async()=>({...item,bytes_base64:Buffer.from(bytes).toString('base64'),chunk_sha256:'changed',range:{start:0,end_exclusive:bytes.length}})},'project',item),e=>e.code==='statement_range_invalid');
});

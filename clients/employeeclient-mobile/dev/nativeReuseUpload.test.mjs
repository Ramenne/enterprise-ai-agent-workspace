import test from 'node:test';import assert from 'node:assert/strict';
import {matchingUpload} from '../src/native/reuse-upload.mjs';import {hashFile,uploadLogicalPath} from '../src/native/client.mjs';
test('same-path upload conflict reuses only the exact current original bytes',async()=>{
 const file=new Blob(['actual']);file.name='test.txt';const fixed={material_id:'m',version_id:'v',size:file.size,sha256:await hashFile(file)};
 const path=await uploadLogicalPath('original-key',file.name),seen=[];
 const client={files:async()=>{throw Error('must not invoke fuzzy or vector search');},paths:async(p,paths)=>{seen.push({p,paths});return {items:[{material_id:'m',logical_path:path},{material_id:'other',logical_path:'history/test.txt'}]};},head:async()=>({fixed_ref:fixed})};
 assert.equal(await matchingUpload(client,'p',file,'original-key'),fixed);assert.deepEqual(seen,[{p:'p',paths:[path]}]);
 await assert.rejects(matchingUpload({...client,head:async()=>({fixed_ref:{...fixed,sha256:'a'.repeat(64)}})},'p',file,'original-key'),e=>e.code==='upload_path_has_different_content');
 await assert.rejects(matchingUpload({...client,paths:async()=>({items:[{material_id:'other',logical_path:'history/test.txt'}]})},'p',file,'original-key'),e=>e.code==='upload_path_conflict');
 assert.notEqual(path,await uploadLogicalPath('another-key',file.name));
});
test('cancel or account change stops conflict recovery before subsequent reads',async()=>{
 const file=new Blob(['actual']);file.name='test.txt';let valid=true,heads=0;
 const client={paths:async()=>{valid=false;return {items:[]};},head:async()=>{heads++;}};
 await assert.rejects(matchingUpload(client,'p',file,'key',()=>{if(!valid)throw new DOMException('cancelled','AbortError');}),{name:'AbortError'});assert.equal(heads,0);
});

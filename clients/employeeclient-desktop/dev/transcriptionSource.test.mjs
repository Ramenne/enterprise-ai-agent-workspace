import test from 'node:test';import assert from 'node:assert/strict';
import {voiceSource} from '../src/chat/transcription-source.mjs';
const material='cfe3f0af-af84-4c63-a0d6-2d0677caaddd',version='8662ae87-2e86-405e-aa76-c2b6e807b0b1',id=material+':'+version,sha256='a'.repeat(64),project='project';
test('known message source and original saved job avoid metadata re-reads',async()=>{
 let calls=0;const resolve=async()=>{calls++;return {};};
 const expected={project_id:project,material_id:material,version_id:version,sha256};
 assert.deepEqual(await voiceSource(id,{sha256},null,resolve,project),expected);
 assert.deepEqual(await voiceSource(id,null,{identity:JSON.stringify(Object.values(expected))},resolve,project),expected);
 assert.equal(calls,0);
});
test('unmapped and changed sources fail before network; first historical entry resolves once',async()=>{
 let calls=0;const resolve=async()=>{calls++;return 'resolved';};
 await assert.rejects(voiceSource('private:invalid',{sha256},null,resolve,project));
 await assert.rejects(voiceSource(id,{sha256:'bad'},null,resolve,project));
 await assert.rejects(voiceSource(id,null,{identity:JSON.stringify(['other',material,version,sha256])},resolve,project));
 assert.equal(calls,0);assert.equal(await voiceSource(id,null,null,resolve,project),'resolved');assert.equal(calls,1);
});


test('private source identity includes its attachment ID and restores without publishing a file',async()=>{
 const ref='private:'+material,expected={project_id:project,private_attachment_id:ref,sha256};
 const noRead=()=>{throw Error('must not read public source');};
 assert.deepEqual(await voiceSource(ref,{sha256},null,noRead,project),expected);
 assert.deepEqual(await voiceSource(ref,null,{identity:JSON.stringify([project,'private',ref,sha256])},noRead,project),expected);
 await assert.rejects(voiceSource(ref,null,{identity:JSON.stringify([project,'private','private:'+version,sha256])},noRead,project));
});

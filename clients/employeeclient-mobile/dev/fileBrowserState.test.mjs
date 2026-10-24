import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const compiled = await build({entryPoints:['src/ui/fileBrowserState.ts'],write:false,format:'esm'});
const {readFileBrowserState,saveFileBrowserState}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
test('navigation restores own filters without retaining another account state',()=>{
 const value={scope:'personal',selected:'private-project',search:'notes',scroll:430};
 saveFileBrowserState('alice',value);
 assert.deepEqual(readFileBrowserState('alice'),value);
 const read=readFileBrowserState('alice'); read.selected='mutated';
 assert.equal(readFileBrowserState('alice').selected,'private-project');
 assert.equal(readFileBrowserState('bob'),undefined);
 assert.equal(readFileBrowserState('alice'),undefined);
});

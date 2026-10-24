import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const result = await build({ entryPoints: ['src/domain/personalStorage.ts'], bundle: true, write: false, format: 'esm', plugins: [{ name: 'api-error', setup(b) { b.onResolve({filter:/^@\/api\/client$/}, () => ({path:'error',namespace:'stub'})); b.onLoad({filter:/.*/,namespace:'stub'},()=>({contents:'export class ApiError extends Error {}'})); } }] });
const {personalStorageDisplayLabel: label} = await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
const context={project_id:'a',status:'synced',files:[{file_id:'f'}]};
test('outbound archive success cannot conceal reverse discovery failure',()=>{
 assert.equal(label(context,{state:'failed',projects:[{project_id:'a',state:'failed',last_error:'storage_http_400'}]}),'文件已加载，梦空间同步暂时失败');
});
test('failure in another project does not mark this project failed',()=>{
 assert.equal(label(context,{state:'failed',projects:[{project_id:'a',state:'synced'},{project_id:'b',state:'failed'}]}),'梦空间已同步');
});
test('POST status and GET state both preserve the rate-limit result',()=>{
 for(const key of ['status','state']) assert.equal(label(context,{state:'failed',projects:[{project_id:'a',[key]:'failed',last_error:'storage_http_429'}]}),'文件已加载，梦空间同步暂时受限');
});

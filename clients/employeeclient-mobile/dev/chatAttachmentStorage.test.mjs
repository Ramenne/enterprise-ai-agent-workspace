import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeClient,hashFile} from '../src/native/client.mjs';
const json=v=>Response.json(v);
test('different contents with the same filename get independent stable storage objects',async()=>{
 const paths=new Set(),seen=[];
 const client=new NativeClient({fetcher:async(_url,o)=>{const body=JSON.parse(o.body),a=body.arguments;assert.equal(body.name,'mem.upload.begin');seen.push(a);if(paths.has(a.logical_path))return json({state:'failed',error_code:'conflict'});paths.add(a.logical_path);return json({operation_id:'operation-'+paths.size});}});
 const file=text=>({name:'report.txt',size:text.length,readPart:async(s,e)=>new Blob([text.slice(s,e)])});
 const one=await client.prepareUpload('project',file('one'),'upload-one');const two=await client.prepareUpload('project',file('two'),'upload-two');
 assert.notEqual(one.operation_id,two.operation_id);assert.notEqual(seen[0].logical_path,seen[1].logical_path);
 assert.equal(one.name,two.name);assert.ok(seen.every(x=>x.logical_path.startsWith('员工客户端文件/')));
});
test('a 33 MiB attachment traverses an actual 32 MiB ingress ceiling using bounded parts',async()=>{
 const file=new Blob([new Uint8Array(33*1024*1024)]),hash=await hashFile(file),parts=[],tools=[];
 const client=new NativeClient({fetcher:async(url,o)=>{
  if(url.includes('/native/upload?')){assert.ok(o.body.size<32*1024*1024);parts.push(o.body.size);return json({state:'staged',operation_id:'original',size:o.body.size});}
  const {name,arguments:a}=JSON.parse(o.body);tools.push(name);
  if(name==='mem.upload.multipart.begin')assert.equal(a.part_size,16*1024*1024);
  return json(name==='mem.upload.multipart.resume'?{state:'open',part_size:16*1024*1024,parts:[]}:name==='mem.upload.multipart.part_ticket'?{state:'uploading',ticket:{method:'PUT'}}:name==='mem.upload.publish'?{state:'published',fixed_refs:[{size:file.size,sha256:hash}]}:{state:'completed'});
 }});
 await client.finishUpload({project_id:'project',operation_id:'original',size:file.size,sha256:hash},file);
 assert.deepEqual(parts,[16*1024*1024,16*1024*1024,1024*1024]);assert.equal(tools.at(-1),'mem.upload.publish');assert.ok(!tools.includes('mem.upload.ticket'));
});

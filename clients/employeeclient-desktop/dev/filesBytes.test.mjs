import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { makeFileLibrary } from '../../../../03-代码文档/当前实现/员工客户端文件语音协作-2026-09-25/v8-v2/file-library.mjs';
import { makeCommunicationFiles, COMMUNICATION_FILES_SQL } from '../../../../03-代码文档/当前实现/员工客户端文件语音协作-2026-09-25/v8-v2/communication-files.mjs';

const compiled = await build({entryPoints:[fileURLToPath(new URL('../src/files/multipart.ts',import.meta.url))],bundle:true,write:false,platform:'node',format:'esm'});
const { uploadBlob, waitUpload } = await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const alice={username:'alice',role:'member'},bob={username:'bob',role:'member'};

function storage(){
 const objects=new Map(),leases=new Map(),requests=new Map();let next=0;
 const origin='https://mengchu.example.invalid/',cos='https://mengstore-1316920087.cos.ap-shanghai.myqcloud.com';
 function grant(o,state='uploading'){
  const id='U'+String(++next).padStart(23,'0');
  const lease={id,object:o,state,parts:new Map(),revision:1};leases.set(id,lease);
  return {id,file_id:o.file_id,ver:1,size:o.size,part_size:16*1024**2,capability:'T'.repeat(43),endpoint:origin+'/api/uploads/'+id,state};
 }
 function snapshot(l){return {state:l.state,revision:l.revision,sha256:l.object.sha256,parts:[...l.parts].map(([number,bytes])=>({number,size:bytes.length,etag:createHash('md5').update(bytes).digest('hex')}))};}
 async function fetchImpl(url,opts={}){
  const u=new URL(url),p=u.pathname,body=typeof opts.body==='string'?JSON.parse(opts.body):{};
  if(u.origin===origin&&p==='/api/files/multipart'){
   assert.equal(body.space,'personal');const key=body.space+':'+body.request_id;
   if(requests.has(key))return Response.json(requests.get(key));
   const file_id='f'+String(++next).padStart(5,'0'),o={file_id,space:body.space,path:body.path,size:body.size};objects.set(file_id,o);
   const g=grant(o);requests.set(key,g);return Response.json(g);
  }
  if(u.origin===origin&&p==='/api/files/copy-multipart'){
   assert.equal(body.space,'common');const source=objects.get(body.source_file_id);
   assert.ok(source?.bytes);assert.equal(source.sha256,body.source_version);
   const key=body.space+':'+body.request_id;
   if(requests.has(key))return Response.json(requests.get(key));
   const file_id='f'+String(++next).padStart(5,'0'),o={file_id,space:body.space,path:body.path,size:source.size,bytes:Buffer.from(source.bytes),sha256:source.sha256};objects.set(file_id,o);
   const g=grant(o,'complete');requests.set(key,g);return Response.json(g);
  }
  if(u.origin===origin&&p.startsWith('/api/uploads/')){
   const [, , ,id,action]=p.split('/'),l=leases.get(id);assert.ok(l);assert.equal(opts.headers.Authorization,'Upload '+'T'.repeat(43));
   if(action==='status'||action==='wait')return Response.json(snapshot(l));
   if(action==='part')return Response.json({url:cos+'/upload/'+id+'/'+body.number,size:Math.min(l.object.size-(body.number-1)*16*1024**2,16*1024**2),headers:{}});
   if(action==='complete'){
    const bytes=Buffer.concat([...l.parts].sort(([a],[b])=>a-b).map(([,bytes])=>bytes));
    assert.equal(bytes.length,l.object.size);assert.equal(sha(bytes),body.sha256);
    l.object.bytes=bytes;l.object.sha256=sha(bytes);l.state='complete';l.revision++;return Response.json(snapshot(l));
   }
  }
  if(u.origin===cos&&p.startsWith('/upload/')&&opts.method==='PUT'){
   const [, ,id,n]=p.split('/'),l=leases.get(id);assert.ok(l);l.parts.set(Number(n),Buffer.from(await opts.body.arrayBuffer()));l.revision++;
   return new Response(null,{status:200});
  }
  if(u.origin===origin&&/^\/f\/[^/]+\/history$/.test(p)){
   const id=p.split('/')[2],o=objects.get(id);if(!o?.bytes)return new Response(null,{status:404});
   return Response.json({file_id:id,space:o.space,path:o.path,versions:[{ver:1,size:o.size,sha256:o.sha256}]});
  }
  if(u.origin===origin&&/^\/f\/[^/]+$/.test(p)){
   const id=p.split('/')[2];if(!objects.get(id)?.bytes)return new Response(null,{status:404});
   return new Response(null,{status:302,headers:{location:cos+'/download/'+id}});
  }
  if(u.origin===cos&&p.startsWith('/download/')){
   const o=objects.get(p.split('/')[2]);return o?.bytes?new Response(o.bytes,{status:200}):new Response(null,{status:404});
  }
  throw Error('Unexpected storage request: '+url);
 }
 return {objects,fetchImpl};
}

test('real bytes survive phone upload, personal save, common copy, group publish and recipient download',async()=>{
 const db=new DatabaseSync(':memory:');db.exec(COMMUNICATION_FILES_SQL+`CREATE TABLE chat_messages(seq INTEGER PRIMARY KEY,id TEXT,attachments_json TEXT,recalled_at INTEGER,project_id TEXT,task_id TEXT);CREATE TABLE chat_message_hides(message_id TEXT,username TEXT);CREATE TABLE chat_message_changes(change_seq INTEGER PRIMARY KEY,message_id TEXT,audience_username TEXT,created_at INTEGER);`);
 const {objects,fetchImpl}=storage(),originalFetch=globalThis.fetch;globalThis.fetch=fetchImpl;
 const library=makeFileLibrary(db,{fetchImpl}),files=makeCommunicationFiles(db,{fetchImpl});
 const samples=[
  {name:'交接说明.txt',mime:'text/plain',bytes:Buffer.from('员工客户端文件完整性测试\nhello\n')},
  {name:'项目图纸.pdf',mime:'application/pdf',bytes:Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF')},
  {name:'现场照片.png',mime:'image/png',bytes:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==','base64')},
 ];
 try{
  for(const [index,s] of samples.entries()){
   const input={context:{computer:'phone',provider:'local',thread:'group-composer'},attachment:{id:'file-'+index,name:s.name,mime:s.mime,size:s.bytes.length},content_size:s.bytes.length};
   const pending=await library.save(alice,'Bearer alice',input);
   const uploaded=await uploadBlob(new Blob([s.bytes]),pending.grant);
   assert.equal(uploaded.sha256,sha(s.bytes));
   const privateReady=await library.complete(alice,'Bearer alice',pending.file.id);
   assert.equal(privateReady.file.sha256,sha(s.bytes));
   const publicPending=await library.share(alice,'Bearer alice',pending.file.id,files,'share-'+index);
   const copy=await waitUpload(publicPending.grant);
   assert.equal(copy.sha256,sha(s.bytes));
   const publicReady=await files.complete(alice,'Bearer alice',{attachment_id:publicPending.attachment_id,ver:1,sha256:sha(s.bytes)});
   assert.equal(publicReady.attachment.mime,s.mime);
   assert.equal(publicReady.attachment.name,s.name);
   await assert.rejects(files.getPublished(publicPending.attachment_id,bob,'Bearer bob'));
   const attachment=files.attachments([publicPending.attachment_id],alice);
   const messageId='message-'+index;
   db.prepare('INSERT INTO chat_messages VALUES(?,?,?,NULL,NULL,NULL)').run(index+1,messageId,JSON.stringify(attachment));
   files.publish([publicPending.attachment_id],messageId);
   const received=await files.getPublished(publicPending.attachment_id,bob,'Bearer bob');
   const downloaded=Buffer.from(await (await fetchImpl(received.download_url)).arrayBuffer());
   assert.deepEqual(downloaded,s.bytes);assert.equal(sha(downloaded),received.attachment.sha256);
   assert.equal(objects.get(privateReady.file.file_id).space,'personal');
   assert.equal(objects.get(received.attachment.file_id).space,'common');
   assert.notEqual(privateReady.file.file_id,received.attachment.file_id);
  }
 }finally{globalThis.fetch=originalFetch;db.close();}
});

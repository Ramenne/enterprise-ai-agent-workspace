import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createSkillLibrary} from '../skill-library.mjs';
import {crc32,inspectPackage,previewPackage,MAX_PACKAGE_BYTES} from '../skill-package.mjs';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const instructions=description=>`---\nname: example-skill\ndescription: >-\n  ${description}\n  给团队使用。\n---\n# 示例\n\n按照说明执行。<script>alert('xss')</script>\n`;
export function fixtureZip(entries){
 const local=[],central=[];let offset=0;
 for(const [path,content,mode=0o100644] of entries){const name=Buffer.from(path),bytes=Buffer.from(content),crc=crc32(bytes),l=Buffer.alloc(30),c=Buffer.alloc(46);l.writeUInt32LE(0x04034b50);l.writeUInt16LE(20,4);l.writeUInt16LE(0x800,6);l.writeUInt32LE(crc,14);l.writeUInt32LE(bytes.length,18);l.writeUInt32LE(bytes.length,22);l.writeUInt16LE(name.length,26);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(0x314,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x800,8);c.writeUInt32LE(crc,16);c.writeUInt32LE(bytes.length,20);c.writeUInt32LE(bytes.length,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE((mode*65536)>>>0,38);c.writeUInt32LE(offset,42);local.push(l,name,bytes);central.push(c,name);offset+=l.length+name.length+bytes.length}
 const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,directory,end]);
}
const md=Buffer.from(instructions('初始说明')),zip=fixtureZip([['example-skill/SKILL.md',instructions('更新说明')],['example-skill/scripts/run.sh','echo example'],['example-skill/references/example.md','# 参考']]);
const upload=bytes=>({filename:bytes===md?'SKILL.md':'example-skill.zip',packageBase64:bytes.toString('base64'),category:'文档',title:'示例 Skill',tags:'测试',versionLabel:'v1'});
const preview=previewPackage(upload(zip));assert.equal(preview.files.length,3);assert.equal(preview.name,'example-skill');assert.equal(preview.files.find(x=>x.path==='scripts/run.sh').size,12);assert.equal(preview.packageBase64,undefined);
const owner={owner:'ordinary-owner',name:'上传成员'},other={owner:'another-member',name:'另一成员'},admin={owner:'0a664193-f099-408b-ad91-f7fc39fa98e2',name:'FGB'};
const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');const lib=createSkillLibrary(db);
let item=lib.create(owner,upload(md));assert.equal(lib.list(other.owner)[0].canEdit,false);assert.equal(lib.list(admin.owner)[0].canEdit,true);
assert.equal(lib.download(item.id).bytes.equals(md),true);assert.match(lib.detail(other.owner,item.id).version.content,/<script>/);
assert.throws(()=>lib.update(other,{...item,action:'archive'}),e=>e.status===403);assert.throws(()=>lib.create(other,upload(md)),e=>e.status===409);
item=lib.update(owner,{id:item.id,revision:item.revision,action:'version',...upload(zip)});assert.equal(item.currentVersion,2);assert.match(item.description,/更新说明/);assert.equal(lib.detail(other.owner,item.id).versions.length,2);assert.equal(lib.download(item.id,1).bytes.equals(md),true);assert.equal(lib.download(item.id,2).bytes.equals(zip),true);assert.equal(lib.file(item.id,2,'scripts/run.sh').content,'echo example');
assert.throws(()=>lib.update(owner,{id:item.id,revision:item.revision-1,action:'archive'}),e=>e.status===409);assert.throws(()=>lib.update(owner,{id:item.id,revision:item.revision,action:'version',...upload(zip)}),e=>e.status===409);
const renamed=Buffer.from(instructions('其他').replace('example-skill','different-name'));assert.throws(()=>lib.update(owner,{id:item.id,revision:item.revision,action:'version',...upload(renamed),filename:'SKILL.md'}),e=>e.status===400);
item=lib.update(admin,{id:item.id,revision:item.revision,action:'archive'});assert.ok(item.archivedAt);assert.throws(()=>lib.update(owner,{id:item.id,revision:item.revision,action:'version',...upload(zip)}),e=>e.status===409);item=lib.update(owner,{id:item.id,revision:item.revision,action:'restore'});assert.equal(item.archivedAt,null);
const revisions=db.prepare('SELECT count(*) n FROM skill_versions').get().n;db.exec("CREATE TRIGGER audit_reject BEFORE INSERT ON skill_audit BEGIN SELECT RAISE(ABORT,'test audit failure'); END;");assert.throws(()=>lib.update(owner,{...item,action:'edit',title:'不会保存'}));assert.equal(lib.detail(owner.owner,item.id).item.title,'示例 Skill');assert.equal(db.prepare('SELECT count(*) n FROM skill_versions').get().n,revisions);db.exec('DROP TRIGGER audit_reject');
assert.throws(()=>db.prepare('UPDATE skill_versions SET content=?').run('tampered'));assert.throws(()=>db.exec('DELETE FROM skill_versions'));
for(const entries of [[['../SKILL.md',instructions('坏路径')]],[['SKILL.md',instructions('重复')],['SKILL.md','duplicate']],[['SKILL.md',instructions('链接')],['script', 'link',0o120777]],[['SKILL.md',instructions('多个')],['nested/SKILL.md',instructions('多个')]]])assert.throws(()=>inspectPackage('bad.zip',fixtureZip(entries)),e=>e.status===400);
const corrupt=Buffer.from(zip);corrupt[60]^=1;assert.throws(()=>inspectPackage('bad.zip',corrupt),e=>e.status===400);
assert.throws(()=>inspectPackage('SKILL.md',Buffer.from('# No frontmatter')),e=>e.status===400);assert.throws(()=>inspectPackage('SKILL.md',Buffer.alloc(MAX_PACKAGE_BYTES+1)),e=>e.status===413);
const bomb=fixtureZip([['SKILL.md',instructions('bomb')]]),central=bomb.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));bomb.writeUInt32LE(11*1024*1024,central+24);assert.throws(()=>inspectPackage('bomb.zip',bomb),e=>e.status===413);
const mixedCase=Buffer.from('---\nname: Presentations\ndescription: 制作演示文稿。\nversion: 2\n---\n# 说明\n保留原文件的大小写。');const mixed=lib.create(owner,{filename:'SKILL.md',packageBase64:mixedCase.toString('base64'),title:'   ',category:'   '});assert.equal(mixed.name,'Presentations');assert.equal(mixed.title,'Presentations');assert.equal(mixed.category,'未分组');assert.equal(inspectPackage('SKILL.md',mixedCase).versionLabel,'2');assert.ok(lib.download(mixed.id).bytes.equals(mixedCase));
assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');db.close();
console.log('PASS package validation, ZIP path/CRC/size/symlink checks, caller ownership, admin maintenance, immutable historical downloads, archive/restore, CAS and transactional rollback');

const dir=mkdtempSync(join(tmpdir(),'skill-routes-')),app=spawn(process.execPath,['--import','./tests/mock-central.mjs','server.mjs'],{cwd:new URL('../',import.meta.url),env:{...process.env,PORT:'3096',XIANYU_KEY:randomBytes(32).toString('base64'),DATA_PATH:join(dir,'data.sqlite')}});let errors='';app.stderr.on('data',x=>errors+=x);const origin='https://tools.example.invalid/';const request=(path,init={})=>fetch('http://127.0.0.1:3096'+path,{redirect:'manual',...init});
try{
 await new Promise((resolve,reject)=>{app.stdout.once('data',resolve);app.once('exit',()=>reject(Error(errors)));setTimeout(()=>reject(Error('listen timeout')),10000).unref()});
 for(const path of ['/skills/api/items','/skills/api/detail?id=x','/skills/api/download?id=x','/skills/api/file?id=x'])assert.equal((await request(path)).status,401);
 assert.equal((await request('/skills/')).headers.get('location'),'/login');
 const signin=async email=>{const response=await request('/login',{method:'POST',headers:{Origin:origin},body:'email='+email+'&otp=123456'});return {Cookie:response.headers.get('set-cookie').split(';')[0],Origin:origin,'Content-Type':'application/json'}};
 const headers=await signin('viewer@example.test'),otherHeaders=await signin('spoof@example.test'),adminHeaders=await signin('test@example.test');
 const inspection=await request('/skills/api/inspect',{method:'POST',headers,body:JSON.stringify(upload(zip))});assert.equal(inspection.status,200);assert.equal((await inspection.json()).files.length,3);assert.equal((await (await request('/skills/api/items',{headers})).json()).items.length,0);
 assert.equal((await request('/skills/api/inspect',{method:'POST',headers:{Origin:origin},body:JSON.stringify(upload(md))})).status,401);assert.equal((await request('/skills/api/inspect',{method:'POST',headers:{...headers,Origin:'https://evil.test'},body:JSON.stringify(upload(md))})).status,403);
 assert.equal((await request('/skills/',{headers})).status,200);assert.equal((await request('/skills/assets/library.js',{headers})).status,200);
 const created=await request('/skills/api/items',{method:'POST',headers,body:JSON.stringify({...upload(md),owner:admin.owner})});assert.equal(created.status,201);let row=(await created.json()).item;assert.notEqual(row.owner,admin.owner);
 assert.equal((await request('/skills/api/items',{method:'POST',headers:{...headers,Origin:'https://evil.test'},body:JSON.stringify(upload(md))})).status,403);
 assert.equal((await request('/skills/api/update',{method:'POST',headers:otherHeaders,body:JSON.stringify({id:row.id,revision:row.revision,action:'archive'})})).status,403);
 const updated=await request('/skills/api/update',{method:'POST',headers,body:JSON.stringify({id:row.id,revision:row.revision,action:'version',...upload(zip)})});assert.equal(updated.status,200);row=(await updated.json()).item;
 assert.equal((await request('/skills/api/update',{method:'POST',headers,body:JSON.stringify({id:row.id,revision:1,action:'archive'})})).status,409);
 const downloaded=await request('/skills/api/download?id='+row.id+'&version=1',{headers:otherHeaders});assert.equal(downloaded.status,200);assert.match(downloaded.headers.get('content-disposition'),/attachment/);assert.ok(Buffer.from(await downloaded.arrayBuffer()).equals(md));
 const file=await request('/skills/api/file?'+new URLSearchParams({id:row.id,path:'scripts/run.sh'}),{headers:otherHeaders});assert.equal(file.status,200);assert.equal((await file.json()).content,'echo example');
 const archive=await request('/skills/api/update',{method:'POST',headers:adminHeaders,body:JSON.stringify({id:row.id,revision:row.revision,action:'archive'})});assert.equal(archive.status,200);
 assert.equal((await request('/skills/api/detail?id='+row.id+'&version=100',{headers})).status,404);
 console.log('PASS HTTP unified login, anonymous API gate, shared member viewing/download, creator maintenance, forged ownership rejection, cross-origin refusal, historical version download and conflict responses');
}finally{if(app.exitCode===null){app.kill('SIGTERM');await new Promise(resolve=>app.once('exit',resolve))}rmSync(dir,{recursive:true,force:true})}

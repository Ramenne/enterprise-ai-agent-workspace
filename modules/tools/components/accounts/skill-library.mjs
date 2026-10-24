import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {isAdmin} from './access-control.mjs';
import {fail,packageFromBody,inspectPackage,previewPackage} from './skill-package.mjs';

const fields=`id,name,description,title,category,tags,note,owner,owner_name AS ownerName,revision,current_version AS currentVersion,created_at AS createdAt,updated_at AS updatedAt,archived_at AS archivedAt`;
const clean=(value,max,label)=>{if(typeof value!=='string'||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))throw fail(400,label+'格式无效');return value.trim()};
const metadata=(body,pkg)=>({title:clean(body.title||pkg.name,180,'名称')||pkg.name,category:clean(body.category||'未分组',80,'分组')||'未分组',tags:clean(body.tags||'',300,'标签'),note:clean(body.note||'',2000,'备注')});
export function createSkillLibrary(db){
 db.exec(`CREATE TABLE IF NOT EXISTS skill_library(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,description TEXT NOT NULL,title TEXT NOT NULL,category TEXT NOT NULL,tags TEXT NOT NULL,note TEXT NOT NULL,owner TEXT NOT NULL,owner_name TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,current_version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,archived_at TEXT);
 CREATE TABLE IF NOT EXISTS skill_versions(item_id TEXT NOT NULL REFERENCES skill_library(id),version INTEGER NOT NULL,version_label TEXT NOT NULL,filename TEXT NOT NULL,format TEXT NOT NULL,package BLOB NOT NULL,sha256 TEXT NOT NULL,size INTEGER NOT NULL,content TEXT NOT NULL,files_json TEXT NOT NULL,actor TEXT NOT NULL,actor_name TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(item_id,version),UNIQUE(item_id,sha256));
 CREATE TABLE IF NOT EXISTS skill_audit(id TEXT PRIMARY KEY,item_id TEXT NOT NULL REFERENCES skill_library(id),actor TEXT NOT NULL,actor_name TEXT NOT NULL,action TEXT NOT NULL,at TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS skill_versions_immutable_update BEFORE UPDATE ON skill_versions BEGIN SELECT RAISE(ABORT,'immutable skill version'); END;
 CREATE TRIGGER IF NOT EXISTS skill_versions_immutable_delete BEFORE DELETE ON skill_versions BEGIN SELECT RAISE(ABORT,'immutable skill version'); END;`);
 const row=id=>db.prepare(`SELECT ${fields} FROM skill_library WHERE id=?`).get(id);
 const required=id=>{const item=row(id);if(!item)throw fail(404,'Skill 不存在');return item};
 const publicRow=(item,actor)=>({...item,canEdit:item.owner===actor||isAdmin(actor)});
 const canEdit=(member,item)=>{if(item.owner!==member.owner&&!isAdmin(member.owner))throw fail(403,'仅上传者和管理员可以维护此 Skill')};
 const audit=(member,id,action,at)=>db.prepare('INSERT INTO skill_audit VALUES(?,?,?,?,?,?)').run(randomUUID(),id,member.owner,member.name||'成员',action,at);
 const saveVersion=(member,id,version,body,pkg,now)=>db.prepare('INSERT INTO skill_versions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,version,clean(body.versionLabel||'',100,'版本备注'),body.filename,pkg.format,pkg.bytes,pkg.sha256,pkg.size,pkg.content,JSON.stringify(pkg.files.map(f=>({path:f.path,size:f.bytes.length}))),member.owner,member.name||'成员',now);
 const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result}catch(error){db.exec('ROLLBACK');throw error}};
 const versionRow=(id,version)=>{const item=required(id),v=version===null||version===undefined?item.currentVersion:Number(version);if(!Number.isSafeInteger(v)||v<1)throw fail(400,'版本无效');const result=db.prepare('SELECT version,version_label AS versionLabel,filename,format,sha256,size,content,files_json AS filesJson,actor_name AS actorName,at FROM skill_versions WHERE item_id=? AND version=?').get(id,v);if(!result)throw fail(404,'版本不存在');return result};
 return {
  list(actor){return db.prepare(`SELECT ${fields},(SELECT size FROM skill_versions v WHERE v.item_id=skill_library.id AND v.version=skill_library.current_version) AS size FROM skill_library ORDER BY updated_at DESC,id`).all().map(x=>publicRow(x,actor))},
  detail(actor,id,version){const item=required(id),v=versionRow(id,version),{filesJson,...detail}=v;return {item:publicRow(item,actor),version:{...detail,files:JSON.parse(filesJson)},versions:db.prepare('SELECT version,version_label AS versionLabel,filename,format,size,actor_name AS actorName,at FROM skill_versions WHERE item_id=? ORDER BY version DESC').all(id)}},
  download(id,version){const v=versionRow(id,version);return {...v,bytes:Buffer.from(db.prepare('SELECT package FROM skill_versions WHERE item_id=? AND version=?').get(id,v.version).package)}},
  file(id,version,path){const archive=this.download(id,version),pkg=inspectPackage(archive.filename,archive.bytes),file=pkg.files.find(x=>x.path===path);if(!file)throw fail(404,'文件不存在');if(file.bytes.length>1024*1024)throw fail(413,'文件超过 1 MB，请下载后查看');let content;try{content=new TextDecoder('utf-8',{fatal:true}).decode(file.bytes)}catch{throw fail(400,'二进制文件请下载后查看')}if(content.includes('\0'))throw fail(400,'二进制文件请下载后查看');return {path,content}},
  create(member,body,onSaved=null){
   const pkg=packageFromBody(body),m=metadata(body,pkg),id=randomUUID(),now=new Date().toISOString();
   if(db.prepare('SELECT 1 FROM skill_library WHERE name=?').get(pkg.name))throw fail(409,'库里已有同名 Skill，请打开原条目更新版本或恢复归档');
   transaction(()=>{db.prepare('INSERT INTO skill_library(id,name,description,title,category,tags,note,owner,owner_name,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,pkg.name,pkg.description,m.title,m.category,m.tags,m.note,member.owner,member.name||'成员',now,now);saveVersion(member,id,1,body,pkg,now);audit(member,id,'import',now);onSaved?.(publicRow(row(id),member.owner))});
   return publicRow(row(id),member.owner);
  },
  update(member,body,onSaved=null){
   const item=required(body?.id);canEdit(member,item);
   if(!Number.isSafeInteger(body.revision)||body.revision!==item.revision)throw fail(409,'Skill 已更新，请刷新后重试');
   const action=body.action||'edit';if(!['edit','version','archive','restore'].includes(action))throw fail(400,'操作无效');
   let pkg=null,m=item,nextVersion=item.currentVersion;
   if(action==='version'){
    if(item.archivedAt)throw fail(409,'请先恢复此 Skill 再更新版本');pkg=packageFromBody(body);
    if(pkg.name!==item.name)throw fail(400,'新版本的 name 须与原 Skill 一致');
    if(db.prepare('SELECT 1 FROM skill_versions WHERE item_id=? AND sha256=?').get(item.id,pkg.sha256))throw fail(409,'该文件已保存为历史版本');nextVersion++;
   }
   if(action==='edit')m=metadata(body,item);
   const now=new Date().toISOString(),archived=action==='archive'?now:action==='restore'?null:item.archivedAt;
   transaction(()=>{
    const changed=db.prepare('UPDATE skill_library SET title=?,category=?,tags=?,note=?,description=?,current_version=?,revision=revision+1,updated_at=?,archived_at=? WHERE id=? AND revision=?').run(m.title,m.category,m.tags,m.note,pkg?.description||item.description,nextVersion,now,archived,item.id,body.revision);
    if(!changed.changes)throw fail(409,'Skill 已更新，请刷新后重试');
    if(pkg)saveVersion(member,item.id,nextVersion,body,pkg,now);audit(member,item.id,action,now);onSaved?.(publicRow(row(item.id),member.owner));
   });return publicRow(row(item.id),member.owner);
  }
 };
}
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data))};
async function body(req){let size=0,parts=[];for await(const part of req){size+=part.length;if(size>7*1024*1024)throw fail(413,'上传文件最大 5 MB');parts.push(part)}try{const value=JSON.parse(Buffer.concat(parts).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value}catch{throw fail(400,'请求格式无效')}}
export function skillLibraryHandler(library,{webRoot=fileURLToPath(new URL('./skill-library-web/',import.meta.url))}={}){
 return async(req,res,url,member)=>{
  try{
   const path=url.pathname;
   if(path==='/skills'){res.writeHead(303,{Location:'/skills/'});return res.end()}
   if(path==='/skills/api/items'&&req.method==='GET')return json(res,200,{items:library.list(member.owner)});
   if(path==='/skills/api/inspect'&&req.method==='POST')return json(res,200,previewPackage(await body(req)));
   if(path==='/skills/api/items'&&req.method==='POST')return json(res,201,{item:library.create(member,await body(req))});
   if(path==='/skills/api/update'&&req.method==='POST')return json(res,200,{item:library.update(member,await body(req))});
   if(path==='/skills/api/detail'&&req.method==='GET')return json(res,200,library.detail(member.owner,url.searchParams.get('id'),url.searchParams.get('version')));
   if(path==='/skills/api/file'&&req.method==='GET')return json(res,200,library.file(url.searchParams.get('id'),url.searchParams.get('version'),url.searchParams.get('path')));
   if(path==='/skills/api/download'&&['GET','HEAD'].includes(req.method)){
    const file=library.download(url.searchParams.get('id'),url.searchParams.get('version'));
    res.writeHead(200,{'Content-Type':file.format==='zip'?'application/zip':'text/markdown; charset=utf-8','Content-Disposition':`attachment; filename="${file.format==='zip'?'skill.zip':'SKILL.md'}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,'Cache-Control':'no-store','Content-Length':file.bytes.length});return res.end(req.method==='HEAD'?undefined:file.bytes);
   }
   if(!['GET','HEAD'].includes(req.method))return json(res,405,{error:'方法不支持'});
   const assets={'/skills/':'index.html','/skills/assets/library.css':'library.css','/skills/assets/library.js':'library.js'};
   if(!assets[path])return json(res,404,{error:'页面不存在'});
   const bytes=await readFile(webRoot+assets[path]);res.writeHead(200,{'Content-Type':(path.endsWith('.css')?'text/css':path.endsWith('.js')?'text/javascript':'text/html')+'; charset=utf-8','Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:bytes);
  }catch(error){return json(res,error.status||500,{error:error.status?error.message:'Skill 管理库暂时不可用，请稍后重试'})}
 };
}

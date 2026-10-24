import {randomUUID,createHash,randomBytes,createCipheriv,createDecipheriv,hkdfSync} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {isAdmin} from './access-control.mjs';
import {cloudRpc,createCloudLibrary} from './html-cloud.mjs';

export const fail=(status,message)=>Object.assign(Error(message),{status});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash=value=>createHash('sha256').update(value).digest('hex');
const opKey=()=>{const k=Buffer.from(process.env.XIANYU_KEY||'','base64');if(k.length!==32)throw fail(500,'保存恢复尚未配置');return hkdfSync('sha256',k,Buffer.alloc(0),'knowledge-save-recovery-v1',32)};
const seal=value=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',opKey(),iv),bytes=Buffer.concat([c.update(JSON.stringify(value)),c.final()]);return Buffer.concat([iv,bytes,c.getAuthTag()]).toString('base64')};
const unseal=value=>{const b=Buffer.from(value,'base64'),d=createDecipheriv('aes-256-gcm',opKey(),b.subarray(0,12));d.setAuthTag(b.subarray(-16));return JSON.parse(Buffer.concat([d.update(b.subarray(12,-16)),d.final()]).toString())};
const statuses=['unverified','research','verified','partial','needs_revalidation'];
function text(value,max,label){if(typeof value!=='string'||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))throw fail(400,label+'格式无效');return value.trim()}
function sourceUrl(value){const s=text(value||'',2000,'来源链接');if(!s)return '';let u;try{u=new URL(s)}catch{throw fail(400,'来源链接无效')}if(!['https:','http:'].includes(u.protocol)||u.username||u.password)throw fail(400,'来源须为不含登录凭据的网页链接');return u.href}
export function validateDocument(b){
 if(!b||typeof b!=='object'||Array.isArray(b))throw fail(400,'文档格式无效');
 const d={title:text(b.title,180,'标题'),category:text(b.category||'未分类',80,'分类')||'未分类',summary:text(b.summary||'',2000,'摘要'),tags:text(b.tags||'',300,'标签'),status:b.status||'unverified',sourceName:text(b.sourceName||'',180,'来源账号'),sourceUrl:sourceUrl(b.sourceUrl),scope:text(b.scope||'',3000,'适用范围'),limitations:text(b.limitations||'',5000,'限制'),evidence:text(b.evidence||'',12000,'验证依据'),body:text(b.body,1024*1024,'正文'),reportHref:text(b.reportHref||'',300,'汇报关联'),reportTitle:text(b.reportTitle||'',180,'汇报名称'),skillId:text(b.skillId||'',36,'Skill 关联'),skillTitle:text(b.skillTitle||'',180,'Skill 名称')};
 if(!d.title||!d.body)throw fail(400,'请填写标题和正文');
 if(!statuses.includes(d.status))throw fail(400,'知识状态无效');
 if(['verified','partial'].includes(d.status)&&!d.evidence)throw fail(400,'已验证或部分验证的知识须填写验证依据');
 if(d.status==='partial'&&!d.limitations)throw fail(400,'部分验证须说明未验证的范围或限制');
 if(d.reportHref&&!/^\/html\/cloud\/file\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(d.reportHref))throw fail(400,'请选择 HTML 管理库中的汇报');
 if(d.skillId&&!uuid.test(d.skillId))throw fail(400,'请选择 Skill 管理库中的 Skill');
 if(Buffer.byteLength(JSON.stringify(d))>1024*1024)throw fail(413,'单篇文档最大 1 MB');
 return d;
}

// Shared catalogue and fixed references only. Full documents remain in Dream storage.
export function createKnowledgeLibrary(db,{rpc=cloudRpc}={}){
 db.exec(`CREATE TABLE IF NOT EXISTS knowledge_documents(id TEXT PRIMARY KEY,metadata TEXT NOT NULL,project_id TEXT NOT NULL,project_name TEXT NOT NULL,revision INTEGER NOT NULL,current_version INTEGER NOT NULL,owner TEXT NOT NULL,owner_name TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,archived_at TEXT);
 CREATE TABLE IF NOT EXISTS knowledge_versions(item_id TEXT NOT NULL REFERENCES knowledge_documents(id),version INTEGER NOT NULL,metadata TEXT NOT NULL,material_id TEXT NOT NULL,version_id TEXT NOT NULL,sha256 TEXT NOT NULL,size INTEGER NOT NULL,logical_path TEXT NOT NULL,actor TEXT NOT NULL,actor_name TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(item_id,version));
 CREATE TABLE IF NOT EXISTS knowledge_audit(id TEXT PRIMARY KEY,item_id TEXT NOT NULL REFERENCES knowledge_documents(id),actor TEXT NOT NULL,action TEXT NOT NULL,at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS knowledge_operations(operation_id TEXT PRIMARY KEY,actor TEXT NOT NULL,request_hash TEXT NOT NULL,item_id TEXT NOT NULL,expected_revision INTEGER NOT NULL,version INTEGER NOT NULL,state TEXT NOT NULL,result TEXT,created_at TEXT NOT NULL,encrypted_request TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS knowledge_versions_no_update BEFORE UPDATE ON knowledge_versions BEGIN SELECT RAISE(ABORT,'immutable knowledge version'); END;
 CREATE TRIGGER IF NOT EXISTS knowledge_versions_no_delete BEFORE DELETE ON knowledge_versions BEGIN SELECT RAISE(ABORT,'immutable knowledge version'); END;`);
 const locks=new Set();
 const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result}catch(e){db.exec('ROLLBACK');throw e}};
 const required=id=>{const row=db.prepare('SELECT * FROM knowledge_documents WHERE id=?').get(id);if(!row)throw fail(404,'知识文档不存在');return row};
 const canEdit=(member,row)=>isAdmin(member.owner)||row.owner===member.owner;
 const publicRow=(r,member)=>({id:r.id,...JSON.parse(r.metadata),projectId:r.project_id,projectName:r.project_name,revision:r.revision,currentVersion:r.current_version,ownerName:r.owner_name,createdAt:r.created_at,updatedAt:r.updated_at,archivedAt:r.archived_at,...(member?{canEdit:canEdit(member,r),canArchive:isAdmin(member.owner)}:{})});
 const audit=(id,actor,action,at)=>db.prepare('INSERT INTO knowledge_audit VALUES(?,?,?,?,?)').run(randomUUID(),id,actor,action,at);
 const admin=member=>{if(!isAdmin(member.owner))throw fail(403,'仅管理员可以维护知识文档库')};
 return {
  list(member){return {items:db.prepare('SELECT * FROM knowledge_documents ORDER BY updated_at DESC,id').all().map(row=>publicRow(row,member)),me:{name:member.name,isAdmin:isAdmin(member.owner),canCreate:true},pending:db.prepare("SELECT operation_id AS operationId,encrypted_request FROM knowledge_operations WHERE actor=? AND state='pending' ORDER BY created_at").all(member.owner).map(p=>({operationId:p.operationId,title:unseal(p.encrypted_request).title}))}},
  recover(member,operationId){const operation=db.prepare("SELECT * FROM knowledge_operations WHERE operation_id=? AND actor=? AND state='pending'").get(operationId,member.owner);if(!operation)throw fail(404,'未完成保存不存在');return {request:unseal(operation.encrypted_request)}},
  async save(member,b){
   if(!uuid.test(b?.operationId||'')||!uuid.test(b?.projectId||''))throw fail(400,'请选择保存项目');
   const document=validateDocument(b),requestHash=hash(JSON.stringify({document,id:b.id||null,revision:b.revision??0,projectId:b.projectId,projectName:b.projectName||'资料存储服务项目'}));
   const old=db.prepare('SELECT * FROM knowledge_operations WHERE operation_id=?').get(b.operationId);
   if(old&&(old.actor!==member.owner||old.request_hash!==requestHash))throw fail(409,'本次保存标识已用于其他内容，请重新打开编辑表单');
   if(old?.state==='saved')return {...JSON.parse(old.result),replayed:true};
   if(!old&&!document.sourceName&&!document.sourceUrl)throw fail(400,'请标明来源：填写来源说明或来源链接；原创可注明本人原创');
   let current=b.id?required(b.id):null;
   if(current&&!canEdit(member,current))throw fail(403,'只能修订本人上传的知识文档；他人文档由管理员维护');
   if(current&&(current.archived_at||current.revision!==b.revision||current.project_id!==b.projectId))throw fail(409,'文档已变化，请刷新后重试；已归档文档须先恢复');
   const id=old?.item_id||current?.id||randomUUID(),version=old?.version||(current?current.current_version+1:1),expected=current?.revision||0;
   if(locks.has(id)||locks.has(b.operationId))throw fail(409,'该文档正在保存，请稍后使用原表单再次核对');
   if(db.prepare("SELECT 1 FROM knowledge_operations WHERE item_id=? AND state='pending' AND operation_id<>?").get(id,b.operationId))throw fail(409,'该文档有未完成保存，请先用原表单再次核对');
   locks.add(id);locks.add(b.operationId);
   try{
    if(!old)db.prepare('INSERT INTO knowledge_operations VALUES(?,?,?,?,?,?,?,NULL,?,?)').run(b.operationId,member.owner,requestHash,id,expected,version,'pending',new Date().toISOString(),seal({...b,...document}));
    else db.prepare("UPDATE knowledge_operations SET state='pending' WHERE operation_id=?").run(b.operationId);
    const content=JSON.stringify({schema:'workspace-knowledge-document-v1',id,version,document},null,2)+'\n',sha=hash(content),size=Buffer.byteLength(content),path=`知识文档/${id}/v${version}-${sha.slice(0,16)}.json`;
    const receipt=await rpc(member,'mem.write_text',{project_id:b.projectId,logical_path:path,text:content,properties:{file_format:'json',attributes:{title:document.title,knowledge_document:true,knowledge_id:id,knowledge_version:version}},source:{tool:'知识文档管理库'},idempotency_key:'knowledge-save:'+member.owner+':'+b.operationId});
    const ref=receipt.fixed_refs?.[0]||receipt.fixed_ref;
    if(receipt.state!=='published'||!uuid.test(ref?.material_id||'')||!uuid.test(ref?.version_id||''))return {state:'pending',operationId:b.operationId,message:'资料存储服务尚未确认发布，请保留表单并再次核对。'};
    const read=await rpc(member,'mem.read_full',{project_id:b.projectId,material_id:ref.material_id,version_id:ref.version_id,sha256:sha,encoding:'utf8'});
    const actual=read.text??read.content_text;
    if(typeof actual!=='string'||hash(actual)!==sha)throw fail(502,'保存内容尚未核验通过，请保留表单再次核对');
    const {body,...metadata}=document,now=new Date().toISOString();
    return transaction(()=>{
     current=b.id?required(b.id):null;
     if(current&&(current.revision!==expected||current.archived_at))throw fail(409,'文档已变化，新文件已保留在资料存储服务，未覆盖当前版本');
     if(!current)db.prepare('INSERT INTO knowledge_documents VALUES(?,?,?,?,?,?,?,?,?,?,NULL)').run(id,JSON.stringify(metadata),b.projectId,text(b.projectName||'资料存储服务项目',180,'项目名称'),1,1,member.owner,member.name||'成员',now,now);
     else db.prepare('UPDATE knowledge_documents SET metadata=?,revision=revision+1,current_version=?,updated_at=? WHERE id=? AND revision=?').run(JSON.stringify(metadata),version,now,id,expected);
     db.prepare('INSERT INTO knowledge_versions VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,version,JSON.stringify(metadata),ref.material_id,ref.version_id,sha,size,path,member.owner,member.name||'成员',now);audit(id,member.owner,current?'version':'create',now);
     const result={state:'published',item:publicRow(required(id),member)};db.prepare("UPDATE knowledge_operations SET state='saved',result=? WHERE operation_id=?").run(JSON.stringify(result),b.operationId);return result;
    });
   }catch(e){if([400,401,403].includes(e.status))db.prepare("UPDATE knowledge_operations SET state='failed' WHERE operation_id=?").run(b.operationId);throw e}finally{locks.delete(id);locks.delete(b.operationId)}
  },
  archive(member,b,onSaved=null){admin(member);const row=required(b?.id);if(row.revision!==b.revision)throw fail(409,'文档已更新，请刷新后重试');if(!['archive','restore'].includes(b.action))throw fail(400,'操作无效');if(locks.has(row.id)||db.prepare("SELECT 1 FROM knowledge_operations WHERE item_id=? AND state='pending'").get(row.id))throw fail(409,'文档有未完成保存，请先核对保存结果');const at=new Date().toISOString();transaction(()=>{db.prepare('UPDATE knowledge_documents SET archived_at=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').run(b.action==='archive'?at:null,at,row.id,b.revision);audit(row.id,member.owner,b.action,at);onSaved?.({item:publicRow(required(row.id))})});return {item:publicRow(required(row.id))}},
  async detail(member,id,requested){
   const row=required(id),version=requested==null?row.current_version:Number(requested);if(!Number.isSafeInteger(version)||version<1)throw fail(400,'版本无效');
   const fixed=db.prepare('SELECT * FROM knowledge_versions WHERE item_id=? AND version=?').get(id,version);if(!fixed)throw fail(404,'历史版本不存在');
   const read=await rpc(member,'mem.read_full',{project_id:row.project_id,material_id:fixed.material_id,version_id:fixed.version_id,sha256:fixed.sha256,encoding:'utf8'}),content=read.text??read.content_text;
   if(typeof content!=='string'||hash(content)!==fixed.sha256)throw fail(502,'原文完整性核验未通过');
   let parsed;try{parsed=JSON.parse(content)}catch{throw fail(502,'知识原文格式无效')}
   if(parsed.schema!=='workspace-knowledge-document-v1'||parsed.id!==id||parsed.version!==version)throw fail(502,'知识版本与目录不一致');
   const document=validateDocument(parsed.document);
   return {item:publicRow(row,member),document,version:{version,at:fixed.at,actorName:fixed.actor_name,sha256:fixed.sha256,size:fixed.size},versions:db.prepare('SELECT version,at,actor_name AS actorName FROM knowledge_versions WHERE item_id=? ORDER BY version DESC').all(id)};
  }
 };
}
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data))};
async function body(req){const parts=[];let size=0;for await(const part of req){size+=part.length;if(size>1200*1024)throw fail(413,'单篇文档最大 1 MB');parts.push(part)}try{return JSON.parse(Buffer.concat(parts).toString('utf8'))}catch{throw fail(400,'请求格式无效')}}
export function knowledgeLibraryHandler(library,{cloud=createCloudLibrary(),webRoot=fileURLToPath(new URL('./knowledge-library-web/',import.meta.url))}={}){
 return async(req,res,url,member)=>{try{
  const p=url.pathname;
  if(p==='/knowledge'){res.writeHead(303,{Location:'/knowledge/'});return res.end()}
  if(p==='/knowledge/api/items'&&req.method==='GET')return json(res,200,library.list(member));
  if(p==='/knowledge/api/recover'&&req.method==='GET')return json(res,200,library.recover(member,url.searchParams.get('operationId')));
  if(p==='/knowledge/api/projects'&&req.method==='GET')return json(res,200,await cloud.projects(member));
  if(p==='/knowledge/api/save'&&req.method==='POST'){const result=await library.save(member,await body(req));return json(res,result.state==='published'?201:202,result)}
  if(p==='/knowledge/api/archive'&&req.method==='POST')return json(res,200,library.archive(member,await body(req)));
  if(p==='/knowledge/api/detail'&&req.method==='GET')return json(res,200,await library.detail(member,url.searchParams.get('id'),url.searchParams.get('version')));
  if(p==='/knowledge/api/download'&&['GET','HEAD'].includes(req.method)){const data=await library.detail(member,url.searchParams.get('id'),url.searchParams.get('version')),bytes=Buffer.from(data.document.body+'\n');res.writeHead(200,{'Content-Type':'text/markdown; charset=utf-8','Content-Disposition':`attachment; filename="knowledge.md"; filename*=UTF-8''${encodeURIComponent(data.document.title+'.md')}`,'Cache-Control':'no-store','Content-Length':bytes.length});return res.end(req.method==='HEAD'?undefined:bytes)}
  const asset={'/knowledge/':'index.html','/knowledge/assets/library.css':'library.css','/knowledge/assets/library.js':'library.js','/knowledge/assets/markdown.js':'markdown.js'}[p];
  if(!asset)throw fail(404,'页面或接口不存在');if(!['GET','HEAD'].includes(req.method))throw fail(405,'方法不支持');const bytes=await readFile(webRoot+asset);res.writeHead(200,{'Content-Type':(asset.endsWith('.css')?'text/css':asset.endsWith('.js')?'text/javascript':'text/html')+'; charset=utf-8','Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:bytes);
 }catch(e){json(res,e.status||500,{error:e.status?e.message:'知识文档库暂时不可用，请稍后重试'})}};
}

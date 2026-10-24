import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {central} from './hufu-auth.mjs';
import {createCloudLibrary} from './html-cloud.mjs';
import {isAdmin} from './access-control.mjs';
const fail=(status,message)=>Object.assign(Error(message),{status});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TEAM='69197d56-41b0-4c8b-ac19-181f63e87c1f';
const FILE_LIMIT=10*1024*1024,TOTAL_LIMIT=30*1024*1024;
function text(value,max,label,required=false){if(typeof value!=='string'||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))throw fail(400,label+'格式无效');const s=value.trim();if(required&&!s)throw fail(400,'请填写'+label);return s}
function cents(value,label){const s=String(value??'');if(!/^\d{1,9}(\.\d{1,2})?$/.test(s))throw fail(400,label+'须为非负金额，最多两位小数');const [a,b='']=s.split('.');const n=Number(a)*100+Number(b.padEnd(2,'0'));if(!Number.isSafeInteger(n)||n>10000000000)throw fail(400,label+'过大');return n}
function date(value,label){if(!/^\d{4}-\d{2}-\d{2}$/.test(value||'')||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)throw fail(400,label+'无效');return value}
function link(value){const s=text(value||'',2000,'商品链接');if(!s)return '';let u;try{u=new URL(s)}catch{throw fail(400,'商品链接无效')}if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw fail(400,'商品链接须为普通网页地址');return u.href}
function validateFile(f){
 const name=text(f?.name,180,'凭证文件名',true);if(/[\/\\\r\n]/.test(name))throw fail(400,'凭证文件名无效');
 const encoded=f.base64;
 if(typeof encoded!=='string'||encoded.length>Math.ceil(FILE_LIMIT/3)*4||encoded.length%4!==0)throw fail(400,'凭证文件无效或超过 10 MB');
 // Scan the alphabet once; grouped repetition can overflow V8's stack on large attachments.
 const padding=encoded.endsWith('==')?2:encoded.endsWith('=')?1:0;
 if(/[^A-Za-z0-9+/]/.test(encoded.slice(0,encoded.length-padding)))throw fail(400,'凭证 Base64 格式无效');
 const bytes=Buffer.from(encoded,'base64');if(!bytes.length||bytes.length>FILE_LIMIT)throw fail(413,'每份凭证最大 10 MB');
 // Buffer's decoder tolerates malformed encodings; require canonical padding and pad bits.
 if(bytes.toString('base64')!==encoded)throw fail(400,'凭证 Base64 格式无效');
 let mime;
 if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))mime='image/png';
 else if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)mime='image/jpeg';
 else if(['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString()))mime='image/gif';
 else if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')mime='image/webp';
 else if(bytes.subarray(0,5).toString()==='%PDF-')mime='application/pdf';
 else throw fail(400,'凭证仅支持 PNG、JPG、GIF、WebP 图片和 PDF');
 const extension=/\.([^.]+)$/.exec(name)?.[1].toLowerCase();if(!({'image/png':['png'],'image/jpeg':['jpg','jpeg'],'image/gif':['gif'],'image/webp':['webp'],'application/pdf':['pdf']}[mime].includes(extension)))throw fail(400,'凭证扩展名与文件内容不一致');
 return {id:randomUUID(),name,mime,size:bytes.length,sha256:hash(bytes),bytes};
}
export async function currentMembers(member){
 const items=[],seen=new Set();let offset=0;
 do{const r=await central('/v2/projects/members',{token:member.token,cookie:member.cookie,body:{project_id:TEAM,limit:100,offset}});if(!r.ok)throw fail(r.status===403?403:503,'中枢成员目录暂时不可用，请稍后重试');const d=r.data?.body||r.data;if(!Array.isArray(d?.members))throw fail(503,'中枢成员目录暂时不可用');items.push(...d.members);offset=d.next_offset;if(offset!=null){if(seen.has(offset))throw fail(503,'中枢成员目录未读取完整');seen.add(offset)}}while(offset!=null);
 return items.filter(x=>uuid.test(x.actor_id||'')).map(x=>({id:x.actor_id,name:x.display_name||'成员'}));
}
export function createHardware(db,{members=currentMembers,projects=member=>createCloudLibrary().projects(member)}={}){
 db.exec(`CREATE TABLE IF NOT EXISTS hardware_orders(id TEXT PRIMARY KEY,document TEXT NOT NULL,registrar_id TEXT NOT NULL,registrar_name TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,archived_at TEXT);
 CREATE TABLE IF NOT EXISTS hardware_files(id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES hardware_orders(id),name TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,bytes BLOB NOT NULL,actor_id TEXT NOT NULL,created_at TEXT NOT NULL,removed_at TEXT);
 CREATE TABLE IF NOT EXISTS hardware_history(id INTEGER PRIMARY KEY,order_id TEXT NOT NULL REFERENCES hardware_orders(id),revision INTEGER NOT NULL,action TEXT NOT NULL,actor_id TEXT NOT NULL,actor_name TEXT NOT NULL,at TEXT NOT NULL,snapshot TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS hardware_operations(actor_id TEXT NOT NULL,operation_id TEXT NOT NULL,request_hash TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(actor_id,operation_id));
 CREATE INDEX IF NOT EXISTS hardware_orders_date ON hardware_orders(updated_at,id); CREATE INDEX IF NOT EXISTS hardware_files_order ON hardware_files(order_id);`);
 const required=id=>{if(!uuid.test(id||''))throw fail(400,'采购记录编号无效');const row=db.prepare('SELECT * FROM hardware_orders WHERE id=?').get(id);if(!row)throw fail(404,'采购记录不存在');return row};
 const canEdit=(member,row)=>member.owner===row.registrar_id||isAdmin(member.owner);
 const files=(id,all=false)=>db.prepare('SELECT id,name,mime,size,sha256,actor_id AS actorId,created_at AS createdAt,removed_at AS removedAt FROM hardware_files WHERE order_id=?'+(all?'':' AND removed_at IS NULL')+' ORDER BY created_at,id').all(id);
 const publicRow=(row,member)=>({id:row.id,...JSON.parse(row.document),registrarId:row.registrar_id,registrarName:row.registrar_name,revision:row.revision,createdAt:row.created_at,updatedAt:row.updated_at,archivedAt:row.archived_at,canEdit:canEdit(member,row),fileCount:db.prepare('SELECT count(*) n FROM hardware_files WHERE order_id=? AND removed_at IS NULL').get(row.id).n});
 function transaction(fn){db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}
 function audit(row,member,action,at){db.prepare('INSERT INTO hardware_history(order_id,revision,action,actor_id,actor_name,at,snapshot) VALUES(?,?,?,?,?,?,?)').run(row.id,row.revision,action,member.owner,member.name,at,JSON.stringify({...publicRow(row,member),files:files(row.id)}))}
 function replay(member,b,kind){if(!uuid.test(b?.operationId||''))throw fail(400,'缺少保存请求标识');const digest=hash(JSON.stringify({kind,body:b}));const old=db.prepare('SELECT * FROM hardware_operations WHERE actor_id=? AND operation_id=?').get(member.owner,b.operationId);if(old){if(old.request_hash!==digest)throw fail(409,'保存标识已用于其他内容，请重新打开表单');return {digest,result:JSON.parse(old.result)}}return {digest}}
 function operation(member,b,digest,result){db.prepare('INSERT INTO hardware_operations VALUES(?,?,?,?)').run(member.owner,b.operationId,digest,JSON.stringify(result));return result}
 function where(q={}){
  const clauses=[q.archived==='true'?'archived_at IS NOT NULL':'archived_at IS NULL'],values=[];
  const search=text(q.search||'',200,'搜索');if(search){clauses.push('(document LIKE ? ESCAPE \'\\\' OR registrar_name LIKE ? ESCAPE \'\\\')');const needle='%'+search.replace(/[\\%_]/g,'\\$&')+'%';values.push(needle,needle)}
  for(const [key,path] of [['buyer','buyerId'],['platform','platform']])if(q[key]){clauses.push(`json_extract(document,'$.${path}')=?`);values.push(text(q[key],180,'筛选'))}
  for(const [key,cmp] of [['from','>='],['to','<=']])if(q[key]){clauses.push(`json_extract(document,'$.purchasedAt')${cmp}?`);values.push(date(q[key],'日期'))}
  return {sql:clauses.join(' AND '),values};
 }
 const api={
  async options(member){const list=await members(member);return {members:list,me:{id:member.owner,name:member.name,isAdmin:isAdmin(member.owner)},platforms:['京东','淘宝','天猫','立创商城','拼多多','1688','其他']}},
  projects,
  list(member,q){const w=where(q),page=Number(q?.page||1);if(!Number.isSafeInteger(page)||page<1)throw fail(400,'页码无效');const total=db.prepare('SELECT count(*) n FROM hardware_orders WHERE '+w.sql).get(...w.values).n;const stats=db.prepare("SELECT COALESCE(sum(json_extract(document,'$.paidCents')),0) paidCents,COALESCE(sum(CASE WHEN NOT EXISTS(SELECT 1 FROM hardware_files f WHERE f.order_id=hardware_orders.id AND f.removed_at IS NULL) THEN 1 ELSE 0 END),0) missingEvidence FROM hardware_orders WHERE "+w.sql).get(...w.values);const rows=db.prepare('SELECT * FROM hardware_orders WHERE '+w.sql+' ORDER BY json_extract(document,\'$.purchasedAt\') DESC,created_at DESC,id LIMIT 50 OFFSET ?').all(...w.values,(page-1)*50);return {items:rows.map(r=>publicRow(r,member)),total,page,pageSize:50,stats,me:{id:member.owner,name:member.name}}},
  detail(member,id){const row=required(id);return {item:publicRow(row,member),files:files(id),history:db.prepare('SELECT revision,action,actor_id AS actorId,actor_name AS actorName,at FROM hardware_history WHERE order_id=? ORDER BY id DESC').all(id)}},
  async save(member,b){
   const old=b?.id?required(b.id):null;if(old&&!canEdit(member,old))throw fail(403,'只有登记人和管理员可以修改');if(old?.archived_at)throw fail(409,'请先恢复已归档记录');
   const rep=replay(member,b,'save');if(rep.result)return {...rep.result,replayed:true};
   if(old&&old.revision!==b.revision)throw fail(409,'采购记录已更新，请刷新后重新编辑');
   const roster=await members(member);const buyer=roster.find(x=>x.id===b.buyerId),user=b.userId?roster.find(x=>x.id===b.userId):null;if(!buyer||b.userId&&!user)throw fail(400,'购买人和使用人须从当前中枢成员中选择');
   const previous=old?JSON.parse(old.document):null;let projectId='',projectName='';
   if(b.projectId){if(!uuid.test(b.projectId))throw fail(400,'关联项目无效');if(previous?.projectId===b.projectId){projectId=b.projectId;projectName=previous.projectName}else{const p=(await projects(member)).items.find(x=>x.projectId===b.projectId);if(!p)throw fail(403,'请选择本人有权查看的中枢项目');projectId=p.projectId;projectName=p.title}}
   if(!Array.isArray(b.lines)||!b.lines.length||b.lines.length>100)throw fail(400,'每笔采购须包含 1 至 100 件商品');
   const lines=b.lines.map(l=>{const quantity=Number(l.quantity);if(!Number.isSafeInteger(quantity)||quantity<1||quantity>100000)throw fail(400,'商品数量须为 1 至 100000 的整数');const unitCents=cents(l.unitPrice,'商品单价');if(unitCents*quantity>10000000000)throw fail(400,'商品金额过大');return {name:text(l.name,180,'商品名称',true),spec:text(l.spec||'',300,'型号规格'),quantity,unitCents,url:link(l.url)}});
   const document={platform:text(b.platform,80,'购买平台',true),purchasedAt:date(b.purchasedAt,'购买日期'),buyerId:buyer.id,buyerName:buyer.name,userId:user?.id||'',userName:user?.name||'',projectId,projectName,lines,paidCents:cents(b.paidAmount,'实际支付总额'),shippingCents:cents(b.shipping||'0','运费'),discountCents:cents(b.discount||'0','优惠'),note:text(b.note||'',4000,'备注')};
   if(!Array.isArray(b.newFiles||[])||(b.newFiles||[]).length>12||!Array.isArray(b.removeFileIds||[])||(b.removeFileIds||[]).length>12)throw fail(400,'凭证列表无效');const add=(b.newFiles||[]).map(validateFile),remove=b.removeFileIds||[],existing=old?files(old.id):[];if(remove.some(id=>!existing.some(f=>f.id===id)))throw fail(400,'待移除凭证不属于这笔采购');const kept=existing.filter(f=>!remove.includes(f.id));if(kept.length+add.length>12||kept.reduce((n,f)=>n+f.size,0)+add.reduce((n,f)=>n+f.size,0)>TOTAL_LIMIT)throw fail(413,'每笔采购最多 12 份凭证，总计不超过 30 MB');
   return transaction(()=>{const again=replay(member,b,'save');if(again.result)return {...again.result,replayed:true};const at=new Date().toISOString(),id=old?.id||randomUUID();if(old){const latest=required(id);if(latest.revision!==b.revision||latest.archived_at)throw fail(409,'采购记录已更新，请刷新后重新编辑');db.prepare('UPDATE hardware_orders SET document=?,revision=revision+1,updated_at=? WHERE id=?').run(JSON.stringify(document),at,id)}else db.prepare('INSERT INTO hardware_orders VALUES(?,?,?,?,?,?,?,NULL)').run(id,JSON.stringify(document),member.owner,member.name,1,at,at);
    for(const f of add)db.prepare('INSERT INTO hardware_files VALUES(?,?,?,?,?,?,?,?,?,NULL)').run(f.id,id,f.name,f.mime,f.size,f.sha256,f.bytes,member.owner,at);
    for(const fid of remove)db.prepare('UPDATE hardware_files SET removed_at=? WHERE id=? AND order_id=?').run(at,fid,id);
    audit(required(id),member,old?'edit':'create',at);return operation(member,b,rep.digest,{item:publicRow(required(id),member)});
   });
  },
  archive(member,b){const row=required(b?.id);if(!canEdit(member,row))throw fail(403,'只有登记人和管理员可以归档或恢复');const rep=replay(member,b,'archive');if(rep.result)return {...rep.result,replayed:true};if(!['archive','restore'].includes(b.action))throw fail(400,'操作无效');if(row.revision!==b.revision)throw fail(409,'记录已更新，请刷新后重试');if((b.action==='archive')===!!row.archived_at)throw fail(409,'记录状态已变化，请刷新');return transaction(()=>{const at=new Date().toISOString();db.prepare('UPDATE hardware_orders SET archived_at=?,revision=revision+1,updated_at=? WHERE id=?').run(b.action==='archive'?at:null,at,row.id);audit(required(row.id),member,b.action,at);return operation(member,b,rep.digest,{item:publicRow(required(row.id),member)})})},
  file(member,id){if(!uuid.test(id||''))throw fail(400,'凭证编号无效');const f=db.prepare('SELECT * FROM hardware_files WHERE id=? AND removed_at IS NULL').get(id);if(!f)throw fail(404,'凭证不存在');required(f.order_id);if(hash(f.bytes)!==f.sha256)throw fail(500,'凭证完整性核验失败');return f}
 };
 return api;
}
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value))};
async function body(req){let length=0;const parts=[];for await(const part of req){length+=part.length;if(length>42*1024*1024)throw fail(413,'凭证总计最大 30 MB');parts.push(part)}try{return JSON.parse(Buffer.concat(parts).toString())}catch{throw fail(400,'请求格式无效')}}
export function hardwareHandler(library,{webRoot=fileURLToPath(new URL('./hardware-web/',import.meta.url))}={}){
 return async(req,res,url,member)=>{try{const p=url.pathname;
  if(p==='/hardware'){res.writeHead(303,{Location:'/hardware/'});return res.end()}
  if(req.method==='GET'){
   if(p==='/hardware/api/options')return json(res,200,await library.options(member));
   if(p==='/hardware/api/projects')return json(res,200,await library.projects(member));
   if(p==='/hardware/api/orders')return json(res,200,library.list(member,Object.fromEntries(url.searchParams)));
   if(p==='/hardware/api/detail')return json(res,200,library.detail(member,url.searchParams.get('id')));
   if(p==='/hardware/api/file'){const f=library.file(member,url.searchParams.get('id'));res.writeHead(200,{'Content-Type':f.mime,'Content-Disposition':`attachment; filename="evidence.${f.mime==='application/pdf'?'pdf':f.mime.split('/')[1]}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,'Content-Length':f.size,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});return res.end(f.bytes)}
  }
  if(req.method==='POST'){
   if(req.headers.origin!=='https://tools.example.invalid/')throw fail(403,'请求来源无效');
   if(p==='/hardware/api/save')return json(res,201,await library.save(member,await body(req)));
   if(p==='/hardware/api/archive')return json(res,200,library.archive(member,await body(req)));
  }
  const asset={'/hardware/':'index.html','/hardware/assets/app.js':'app.js','/hardware/assets/app.css':'app.css'}[p];if(!asset)throw fail(404,'页面或接口不存在');if(!['GET','HEAD'].includes(req.method))throw fail(405,'方法不支持');const bytes=await readFile(webRoot+asset);res.writeHead(200,{'Content-Type':(asset.endsWith('.js')?'text/javascript':asset.endsWith('.css')?'text/css':'text/html')+'; charset=utf-8','Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:bytes);
 }catch(e){json(res,e.status||500,{error:e.status?e.message:'硬件采购平台暂时不可用，请稍后重试'})}};
}

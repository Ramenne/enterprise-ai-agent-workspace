import {createHistory} from './account-history.mjs';
import {randomUUID,randomBytes,hkdfSync,createCipheriv,createDecipheriv} from 'node:crypto';
export function createVault(db,{shared=false,access=null}={}){
 const master=Buffer.from(process.env.XIANYU_KEY||'','base64');if(master.length!==32)throw Error('Vault key unavailable');
 const key=Buffer.from(hkdfSync('sha256',master,Buffer.alloc(0),'xianyu-account-vault-v1',32));
 db.exec('CREATE TABLE IF NOT EXISTS account_vault(id TEXT PRIMARY KEY,owner TEXT NOT NULL,label TEXT NOT NULL,secret TEXT NOT NULL,revision INTEGER NOT NULL,archived INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS account_vault_owner ON account_vault(owner)');
 db.exec("CREATE TABLE IF NOT EXISTS vault_projects(id TEXT PRIMARY KEY,owner TEXT NOT NULL,name TEXT NOT NULL,created_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS vault_projects_owner ON vault_projects(owner)");
 const columns=db.prepare('PRAGMA table_info(account_vault)').all().map(r=>r.name);
 if(!columns.includes('platform'))db.exec("ALTER TABLE account_vault ADD COLUMN platform TEXT NOT NULL DEFAULT '闲鱼'");
 if(!columns.includes('project_id'))db.exec("ALTER TABLE account_vault ADD COLUMN project_id TEXT");
 if(!columns.includes('deleted_at'))db.exec('ALTER TABLE account_vault ADD COLUMN deleted_at TEXT');
 db.exec('CREATE TABLE IF NOT EXISTS vault_audit(id TEXT PRIMARY KEY,actor TEXT NOT NULL,record_id TEXT NOT NULL,action TEXT NOT NULL,created_at TEXT NOT NULL)');
 const history=createHistory(db);
 const seal=(owner,id,value)=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(JSON.stringify([owner,id])));return Buffer.concat([iv,c.update(JSON.stringify(value),'utf8'),c.final(),c.getAuthTag()]).toString('base64')};
 const open=r=>{const b=Buffer.from(r.secret,'base64'),c=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));c.setAAD(Buffer.from(JSON.stringify([r.owner,r.id])));c.setAuthTag(b.subarray(-16));return JSON.parse(Buffer.concat([c.update(b.subarray(12,-16)),c.final()]).toString('utf8'))};
 const publicRow=r=>{const s=open(r);return {id:r.id,label:r.label,username:s.username,note:s.note,device:s.device||'',platform:r.platform,projectId:r.project_id||'',deleted:!!r.deleted_at,passwordStored:!!s.password,revision:r.revision,archived:!!r.archived,updatedAt:r.updated_at,...history.metadata(r)}};
 const fail=(status,message)=>Object.assign(new Error(message),{status});
 const clientRow=(owner,row)=>{const value=publicRow(row),allowed=!access||access.canView(owner,row.id);const {note,...safe}=value;return {...safe,noteStored:!!note,canReveal:allowed,canReadNote:allowed}};
 const groupName=id=>id?db.prepare('SELECT name FROM vault_projects WHERE id=?').get(id)?.name||'已删除分组':'未分组';
 const differences=(before,after)=>{const changes=[];for(const [key,field] of Object.entries({label:'账号名称',username:'账号',platform:'平台 / 服务',projectId:'分组',device:'登录设备',note:'备注'})){const a=key==='projectId'?groupName(before?.[key]):before?.[key]||'',b=key==='projectId'?groupName(after[key]):after[key]||'';if(a!==b)changes.push({field,before:a,after:b})}return changes};
 return {
 history(owner,id,before){const row=shared?db.prepare('SELECT * FROM account_vault WHERE id=?').get(id):db.prepare('SELECT * FROM account_vault WHERE id=? AND owner=?').get(id,owner);if(!row||row.deleted_at&&access&&!access.isAdmin(owner))throw fail(404,'账号不存在');return history.read(id,!access||access.isAdmin(owner),before,!access||access.canView(owner,id))},
 notes(owner,id,revision){const row=shared?db.prepare('SELECT * FROM account_vault WHERE id=?').get(id):db.prepare('SELECT * FROM account_vault WHERE id=? AND owner=?').get(id,owner);if(!row||row.deleted_at||access&&!access.canView(owner,id))throw fail(404,'账号不存在或无权查看备注');if(revision!==undefined&&revision!==null&&revision!==''&&(!Number.isInteger(Number(revision))||Number(revision)!==row.revision))throw fail(409,'记录已变化，请返回列表刷新后再编辑');history.record(owner,id,'note_view');return {id:row.id,label:row.label,platform:row.platform,revision:row.revision,note:open(row).note||''}},
 copy(owner,b){if(typeof b?.id!=='string'||!Number.isInteger(b.revision))throw fail(400,'请选择有效账号');const row=shared?db.prepare('SELECT * FROM account_vault WHERE id=?').get(b.id):db.prepare('SELECT * FROM account_vault WHERE id=? AND owner=?').get(b.id,owner);if(!row||row.deleted_at||access&&!access.canView(owner,row.id))throw fail(404,'账号不存在或无权查看');if(row.revision!==b.revision)throw fail(409,'记录已变化，请刷新');if(b.kind!==undefined&&b.kind!=='note')throw fail(400,'复制类型无效');history.record(owner,row.id,b.kind==='note'?'note_copy':'copy');return {recorded:true}},
 projects(owner){return shared?db.prepare('SELECT id,name,created_at AS createdAt FROM vault_projects ORDER BY created_at,id').all():db.prepare('SELECT id,name,created_at AS createdAt FROM vault_projects WHERE owner=? ORDER BY created_at,id').all(owner)},
 createProject(owner,b,onSaved=null){if(access&&!access.isAdmin(owner))throw fail(403,'仅管理员可以新建分组');if(typeof b?.name!=='string'||!b.name.trim()||b.name.length>100)throw fail(400,'请输入项目名称（最多100字）');const name=b.name.trim();if(shared?db.prepare('SELECT id FROM vault_projects WHERE name=?').get(name):db.prepare('SELECT id FROM vault_projects WHERE owner=? AND name=?').get(owner,name))throw fail(409,'同名项目已存在');const id=randomUUID(),now=new Date().toISOString();db.exec('BEGIN IMMEDIATE');try{db.prepare('INSERT INTO vault_projects VALUES(?,?,?,?)').run(id,owner,name,now);const item={id,name,createdAt:now};onSaved?.(item);db.exec('COMMIT');return item}catch(e){db.exec('ROLLBACK');throw e}},
 deleteProject(owner,id,onSaved=null){if(access&&!access.isAdmin(owner))throw fail(403,'仅管理员可以删除分组');
 if(typeof id!=='string'||!id)throw fail(400,'请选择分组');
 db.exec('BEGIN IMMEDIATE');try{
 const group=shared?db.prepare('SELECT * FROM vault_projects WHERE id=?').get(id):db.prepare('SELECT * FROM vault_projects WHERE id=? AND owner=?').get(id,owner);
 if(!group)throw fail(404,'分组不存在');
 const now=new Date().toISOString();
 const affected=shared?db.prepare('SELECT * FROM account_vault WHERE project_id=?').all(id):db.prepare('SELECT * FROM account_vault WHERE project_id=? AND owner=?').all(id,owner);
 const granted=access?db.prepare('SELECT actor_id FROM account_group_view_grants WHERE group_id=?').all(id).map(x=>history.name(x.actor_id)):[];
 for(const row of affected){history.record(owner,row.id,'group_removed',{changes:[{field:'分组',before:group.name,after:'未分组'}]});if(granted.length)history.record(owner,row.id,'access_update',{changes:[{field:'密码查看成员',before:granted.join('、')+'（来自分组）',after:'分组授权已移除'}]})}
 const moved=shared?db.prepare('UPDATE account_vault SET project_id=NULL,revision=revision+1,updated_at=? WHERE project_id=?').run(now,id):db.prepare('UPDATE account_vault SET project_id=NULL,revision=revision+1,updated_at=? WHERE project_id=? AND owner=?').run(now,id,owner);
 db.prepare('DELETE FROM vault_projects WHERE id=?').run(id);const result={moved:Number(moved.changes)};onSaved?.(result);db.exec('COMMIT');return result;
 }catch(e){db.exec('ROLLBACK');throw e}
 },
 list(owner){return (shared?db.prepare('SELECT * FROM account_vault ORDER BY updated_at DESC').all():db.prepare('SELECT * FROM account_vault WHERE owner=? ORDER BY updated_at DESC').all(owner)).filter(row=>!access||access.isAdmin(owner)||!row.deleted_at).map(row=>clientRow(owner,row))},
 reveal(owner,b){
 if(typeof b?.id!=='string'||!Number.isInteger(b.revision))throw fail(400,'请选择有效账号');
 const row=shared?db.prepare('SELECT * FROM account_vault WHERE id=?').get(b.id):db.prepare('SELECT * FROM account_vault WHERE id=? AND owner=?').get(b.id,owner);
 if(!row||row.deleted_at||access&&!access.canView(owner,row.id))throw fail(404,'账号不存在或无权查看');
 if(row.revision!==b.revision)throw fail(409,'记录已变化，请刷新后再查看');
 const secret=open(row);history.record(owner,row.id,'reveal');return {password:secret.password||''};
 },
 save(owner,b,onSaved=null){if(access&&!access.isAdmin(owner)&&(b?.id||b?.action))throw fail(403,'仅管理员可以修改账号');db.exec('BEGIN IMMEDIATE');try{const old=b?.id?db.prepare('SELECT * FROM account_vault WHERE id=?').get(b.id):null;const before=old?publicRow(old):null,item=this.mutate(owner,b);const updated=old&&!b.action&&!!b.password&&b.password!==open(old).password;history.record(owner,item.id,b.action||(b.id?'edit':'create'),{changes:b.action?[]:differences(before,item),passwordUpdated:!!updated});const row=db.prepare('SELECT * FROM account_vault WHERE id=?').get(item.id),result=clientRow(owner,row);onSaved?.(result);db.exec('COMMIT');return result}catch(e){db.exec('ROLLBACK');throw e}},
 mutate(owner,b){
 if(!b||typeof b!=='object'||(b.action!==undefined&&!['archive','restore','delete','undelete'].includes(b.action)))throw fail(400,'请求格式无效');
 let old;if(b.id){if(typeof b.id!=='string'||!Number.isInteger(b.revision))throw fail(400,'请求格式无效');old=shared?db.prepare('SELECT * FROM account_vault WHERE id=?').get(b.id):db.prepare('SELECT * FROM account_vault WHERE id=? AND owner=?').get(b.id,owner);if(!old)throw fail(404,'账号不存在');if(old.revision!==b.revision)throw fail(409,'记录已变化，请刷新后再编辑')}
 const now=new Date().toISOString();
 if(b.action==='delete'||b.action==='undelete'){if(!old)throw fail(404,'账号不存在');const r=db.prepare('UPDATE account_vault SET deleted_at=?,revision=revision+1,updated_at=? WHERE id=? AND owner=? AND revision=? RETURNING *').get(b.action==='delete'?now:null,now,old.id,old.owner,b.revision);if(!r)throw fail(409,'记录已变化，请刷新后再操作');return publicRow(r)}
 if(old?.deleted_at)throw fail(409,'请先从回收站恢复账号');
 if(b.action==='archive'||b.action==='restore'){if(!old)throw fail(400,'账号不存在');const r=db.prepare('UPDATE account_vault SET archived=?,revision=revision+1,updated_at=? WHERE id=? AND owner=? AND revision=? RETURNING *').get(b.action==='archive'?1:0,now,old.id,old.owner,b.revision);if(!r)throw fail(409,'记录已变化，请刷新后再编辑');return publicRow(r)}
 const valid=(s,n)=>typeof s==='string'&&s.length<=n;
 if(!valid(b.label,100)||!b.label.trim()||!valid(b.username,254)||!b.username.trim()||!valid(b.password,1024)||!valid(b.note||'',2000)||(!old&&!b.password))throw fail(400,'请填写账号名称、账号和密码，并检查长度');
 const platform=b.platform===undefined?(old?.platform||'闲鱼'):b.platform,projectId=b.projectId===undefined?(old?.project_id||''):b.projectId;
 if(typeof platform!=='string'||!platform.trim()||platform.length>40||typeof projectId!=='string'||projectId.length>36)throw fail(400,'请选择平台和所属项目');
 if(projectId&&!(shared?db.prepare('SELECT id FROM vault_projects WHERE id=?').get(projectId):db.prepare('SELECT id FROM vault_projects WHERE id=? AND owner=?').get(projectId,owner)))throw fail(400,'所属项目不存在或无权访问');
 const device=b.device===undefined?(old?open(old).device||'':''):b.device;
 if(!valid(device,500))throw fail(400,'登录设备需为文本，最多500字');
 const note=b.note===undefined?(old?open(old).note||'':''):b.note;if(old&&note!==(open(old).note||'')&&b.noteRevision!==old.revision)throw fail(409,'备注查看方式已调整，请刷新页面后重新编辑');
 const id=old?.id||randomUUID(),secret=seal(old?.owner||owner,id,{username:b.username.trim(),password:b.password||(old?open(old).password:''),note:note||'',device:device.trim()});
 if(old){const r=db.prepare('UPDATE account_vault SET label=?,secret=?,platform=?,project_id=?,revision=revision+1,updated_at=? WHERE id=? AND owner=? AND revision=? RETURNING *').get(b.label.trim(),secret,platform.trim(),projectId||null,now,id,old.owner,b.revision);if(!r)throw fail(409,'记录已变化，请刷新后再编辑');return publicRow(r)}
 db.prepare('INSERT INTO account_vault(id,owner,label,secret,revision,archived,created_at,updated_at,platform,project_id) VALUES(?,?,?,?,1,0,?,?,?,?)').run(id,owner,b.label.trim(),secret,now,now,platform.trim(),projectId||null);return publicRow(db.prepare('SELECT * FROM account_vault WHERE id=? AND owner=?').get(id,owner));
 }
 };
}

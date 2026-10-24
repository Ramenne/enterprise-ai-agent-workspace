import {randomUUID} from 'node:crypto';
export const privateActions=['note_copy','note_view','reveal','copy','access_update','person_scope_update','member_visibility_update'];
export const businessActions=['create','edit','archive','restore','delete','undelete','group_removed'];
export function createHistory(db){
 db.exec(`CREATE TABLE IF NOT EXISTS vault_audit(id TEXT PRIMARY KEY,actor TEXT NOT NULL,record_id TEXT NOT NULL,action TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS vault_audit_details(audit_id TEXT PRIMARY KEY REFERENCES vault_audit(id),payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS vault_actor_names(actor TEXT PRIMARY KEY,name TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS vault_audit_record ON vault_audit(record_id,created_at);
 CREATE TRIGGER IF NOT EXISTS vault_audit_no_update BEFORE UPDATE ON vault_audit BEGIN SELECT RAISE(ABORT,'history is append only'); END;
 CREATE TRIGGER IF NOT EXISTS vault_audit_no_delete BEFORE DELETE ON vault_audit BEGIN SELECT RAISE(ABORT,'history is append only'); END;
 CREATE TRIGGER IF NOT EXISTS vault_audit_details_no_update BEFORE UPDATE ON vault_audit_details BEGIN SELECT RAISE(ABORT,'history is append only'); END;
 CREATE TRIGGER IF NOT EXISTS vault_audit_details_no_delete BEFORE DELETE ON vault_audit_details BEGIN SELECT RAISE(ABORT,'history is append only'); END;`);
 const name=actor=>db.prepare('SELECT name FROM vault_actor_names WHERE actor=?').get(actor)?.name||'历史成员（身份待核对）';
 return {
 name,
 rememberName(actor,value){if(typeof actor==='string'&&typeof value==='string'&&value.trim())db.prepare('INSERT INTO vault_actor_names VALUES(?,?) ON CONFLICT(actor) DO UPDATE SET name=excluded.name').run(actor,value.trim().slice(0,100))},
 record(actor,id,action,details={}){
  // Only server-built, non-password differences belong in this event payload.
  const fields=new Set(['账号名称','账号','平台 / 服务','分组','登录设备','备注','密码查看成员','授权分组','单独授权账号','禁止查看密码']);
  const changes=(details.changes||[]).map(c=>{if(!fields.has(c.field))throw Error('Invalid history field');return {field:c.field,before:c.before??'',after:c.after??''}});
  const payload=JSON.stringify({actorName:name(actor),changes,passwordUpdated:details.passwordUpdated===true,...(details.targetMemberName?{targetMemberName:String(details.targetMemberName).slice(0,100)}:{})});
  const eventId=randomUUID();db.exec('SAVEPOINT history_event');try{db.prepare('INSERT INTO vault_audit VALUES(?,?,?,?,?)').run(eventId,actor,id,action,new Date().toISOString());db.prepare('INSERT INTO vault_audit_details VALUES(?,?)').run(eventId,payload);db.exec('RELEASE history_event')}catch(e){db.exec('ROLLBACK TO history_event');db.exec('RELEASE history_event');throw e}
 },
 metadata(row){const first=db.prepare("SELECT actor FROM vault_audit WHERE record_id=? AND action='create' ORDER BY rowid LIMIT 1").get(row.id);const last=db.prepare('SELECT actor,created_at FROM vault_audit WHERE record_id=? AND action IN ('+businessActions.map(()=>'?').join(',')+') ORDER BY rowid DESC LIMIT 1').get(row.id,...businessActions);const known=last&&Date.parse(last.created_at)>=Date.parse(row.updated_at);return {creatorName:name(first?.actor||row.owner),createdAt:row.created_at,lastModifiedName:known?name(last.actor):null,lastModifiedAt:known?last.created_at:row.updated_at}},
 read(id,admin,before,canReadNote=false){const conditions=['record_id=?'],args=[id];if(!admin){conditions.push('action NOT IN ('+privateActions.map(()=>'?').join(',')+')');args.push(...privateActions)}if(before!==undefined&&before!==null&&before!==''){const n=Number(before);if(!Number.isSafeInteger(n)||n<1)throw Object.assign(Error('历史分页参数无效'),{status:400});conditions.push('a.rowid<?');args.push(n)}const rows=db.prepare('SELECT a.rowid AS cursor,a.*,d.payload FROM vault_audit a LEFT JOIN vault_audit_details d ON d.audit_id=a.id WHERE '+conditions.join(' AND ')+' ORDER BY a.rowid DESC LIMIT 51').all(...args);const hasMore=rows.length>50,visible=rows.slice(0,50);return {items:visible.map(r=>{const detail=r.payload?JSON.parse(r.payload):null;return {id:r.id,actorName:detail?.actorName||name(r.actor),action:r.action,createdAt:r.created_at,changes:(detail?.changes||[]).map(c=>c.field==='备注'&&!admin&&!canReadNote?{field:'备注',redacted:true}:c),passwordUpdated:!!detail?.passwordUpdated,targetMemberName:detail?.targetMemberName||null,legacy:!detail}}),nextCursor:hasMore?String(visible.at(-1).cursor):null}}
 };
}

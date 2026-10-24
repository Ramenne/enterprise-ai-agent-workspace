import {createHash} from 'node:crypto';
export function jpegDimensions(bytes){if(bytes.length<10)return null;let i=2;while(i+4<bytes.length){if(bytes[i++]!==255)return null;while(bytes[i]===255)i++;const marker=bytes[i++];if(marker===218||marker===217)return null;const length=bytes.readUInt16BE(i);if(length<2||i+length>bytes.length)return null;if([192,194].includes(marker)){if(length<8)return null;return {height:bytes.readUInt16BE(i+3),width:bytes.readUInt16BE(i+5)};}i+=length;}return null;}
const fail=(code,status=400)=>{throw Object.assign(Error(code),{code,status});};
export function createMemberProfiles(db,{now=Date.now}={}){
 db.exec(`CREATE TABLE IF NOT EXISTS employeeclient_member_presence(actor_id TEXT PRIMARY KEY,last_seen_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS employeeclient_member_avatars(actor_id TEXT PRIMARY KEY,mime TEXT NOT NULL,bytes BLOB NOT NULL,version TEXT NOT NULL,updated_at INTEGER NOT NULL);`);
 const connections=new Map();
 function open(actor){const token=Symbol(actor),set=connections.get(actor)||new Set(),changed=set.size===0;set.add(token);connections.set(actor,set);seen(actor);return {token,changed};}
 function seen(actor){db.prepare('INSERT INTO employeeclient_member_presence VALUES(?,?) ON CONFLICT(actor_id) DO UPDATE SET last_seen_at=excluded.last_seen_at').run(actor,now());}
 function close(actor,token){const set=connections.get(actor);if(!set?.delete(token))return false;if(set.size)return false;connections.delete(actor);if(db.isOpen)seen(actor);return true;}
 function member(row){const id=row.actor_id,stamp=db.prepare('SELECT last_seen_at FROM employeeclient_member_presence WHERE actor_id=?').get(id),avatar=db.prepare('SELECT version FROM employeeclient_member_avatars WHERE actor_id=?').get(id);return {username:id,nickname:row.display_name||row.member_label||id,dept:row.dept||'',role:row.role||'',online:!!connections.get(id)?.size,last_seen_at:stamp?.last_seen_at??null,avatar_version:avatar?.version??null};}
 function save(ctx,body){if(!ctx?.can_write)fail('project_write_denied',403);if(Object.keys(body).some(k=>!['mime','bytes_base64'].includes(k)))fail('avatar_body_invalid');
  if(body.mime!=='image/jpeg'||typeof body.bytes_base64!=='string'||body.bytes_base64.length>90000||! /^[A-Za-z0-9+/]*={0,2}$/.test(body.bytes_base64))fail('avatar_format_invalid');
  const bytes=Buffer.from(body.bytes_base64,'base64');if(bytes.length<10||bytes.length>65536||bytes[0]!==255||bytes[1]!==216||bytes.at(-2)!==255||bytes.at(-1)!==217)fail('avatar_format_invalid');
  const dimensions=jpegDimensions(bytes);if(!dimensions||dimensions.width<1||dimensions.height<1||dimensions.width>1024||dimensions.height>1024)fail('avatar_dimensions_invalid');
  const version=createHash('sha256').update(bytes).digest('hex');db.prepare('INSERT INTO employeeclient_member_avatars VALUES(?,?,?,?,?) ON CONFLICT(actor_id) DO UPDATE SET mime=excluded.mime,bytes=excluded.bytes,version=excluded.version,updated_at=excluded.updated_at').run(ctx.actor_id,body.mime,bytes,version,now());return {actor_id:ctx.actor_id,avatar_version:version};
 }
 function avatar(actor){const row=db.prepare('SELECT * FROM employeeclient_member_avatars WHERE actor_id=?').get(actor);if(!row)fail('avatar_not_found',404);return {avatar_version:row.version,data_url:'data:'+row.mime+';base64,'+Buffer.from(row.bytes).toString('base64')};}
 return {member,open,seen,close,save,avatar};
}

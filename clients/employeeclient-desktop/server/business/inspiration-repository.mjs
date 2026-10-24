import {randomUUID,createHash} from 'node:crypto';
const fail=(code,status=400)=>{throw Object.assign(Error(code),{code,status});};
export function createInspirations(db,{read,write,now}){
 db.exec(`CREATE TABLE IF NOT EXISTS employeeclient_inspirations(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,actor_id TEXT NOT NULL,body TEXT NOT NULL,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS employeeclient_inspiration_media(id TEXT PRIMARY KEY,record_id TEXT NOT NULL REFERENCES employeeclient_inspirations(id),mime TEXT NOT NULL,name TEXT NOT NULL,bytes BLOB NOT NULL,sha256 TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS employeeclient_inspirations_owner ON employeeclient_inspirations(actor_id,seq DESC);`);
 function submit(ctx,body,key){
  const text=typeof body.text==='string'?body.text.trim():'';if(text.length>10000||!Array.isArray(body.media)||body.media.length>5||(!text&&!body.media.length))fail('invalid_inspiration');
  let total=0;const media=body.media.map(a=>{if(!a||typeof a.bytes_base64!=='string'||a.bytes_base64.length>24*1024*1024||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(a.bytes_base64))fail('invalid_inspiration_media');
   if(!/^image\/(jpeg|png|webp)$/.test(a.mime)&&!/^audio\/(webm|mp4|mpeg|ogg|wav)(;codecs=[\w,.-]+)?$/.test(a.mime))fail('invalid_inspiration_media');
   const bytes=Buffer.from(a.bytes_base64,'base64');total+=bytes.length;if(!bytes.length||total>16*1024*1024)fail('inspiration_media_too_large',413);
   return {mime:a.mime,name:String(a.name||'记录').slice(0,160),bytes,sha:createHash('sha256').update(bytes).digest('hex')};});
  return write(ctx,'inspiration.save',key,body,()=>{const id=randomUUID(),ts=now();db.prepare('INSERT INTO employeeclient_inspirations(id,actor_id,body,created_at) VALUES(?,?,?,?)').run(id,ctx.actor_id,text,ts);for(const a of media)db.prepare('INSERT INTO employeeclient_inspiration_media VALUES(?,?,?,?,?,?)').run(randomUUID(),id,a.mime,a.name,a.bytes,a.sha);return {state:'saved',id,created_at:ts};});
 }
 function list(ctx,q={}){read(ctx);const before=q.before===undefined?Number.MAX_SAFE_INTEGER:Number(q.before);if(!Number.isSafeInteger(before)||before<0)fail('invalid_cursor');const rows=db.prepare('SELECT * FROM employeeclient_inspirations WHERE actor_id=? AND seq<? ORDER BY seq DESC LIMIT 31').all(ctx.actor_id,before);return {records:rows.slice(0,30).map(row=>({...row,media:db.prepare('SELECT id,mime,name,sha256,length(bytes) AS size FROM employeeclient_inspiration_media WHERE record_id=?').all(row.id)})),next_cursor:rows.length>30?rows[29].seq:null};}
 function media(ctx,id){read(ctx);const row=db.prepare('SELECT m.* FROM employeeclient_inspiration_media m JOIN employeeclient_inspirations r ON r.id=m.record_id WHERE m.id=? AND r.actor_id=?').get(id,ctx.actor_id);if(!row)fail('inspiration_media_not_found',404);return row;}
 return {submit,list,media};
}

import {randomUUID,createHash} from 'node:crypto';
import {jpegDimensions} from './member-profiles.mjs';
const fail=(code,status=400)=>{throw Object.assign(Error(code),{code,status});};
export function createFeedbackRepository(db,{read,write,now=Date.now}){
 db.exec(`CREATE TABLE IF NOT EXISTS employeeclient_feedback(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,actor_id TEXT NOT NULL,display_name TEXT NOT NULL,description TEXT NOT NULL,app_version TEXT NOT NULL,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS employeeclient_feedback_images(feedback_id TEXT NOT NULL REFERENCES employeeclient_feedback(id),position INTEGER NOT NULL,mime TEXT NOT NULL,bytes BLOB NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(feedback_id,position));`);
 function submit(ctx,body,key){
  if(Object.keys(body).some(k=>!['description','images','app_version'].includes(k)))fail('feedback_body_invalid');
  if(typeof body.description!=='string'||!body.description.trim()||body.description.length>5000)fail('feedback_description_invalid');
  if(typeof body.app_version!=='string'||body.app_version.length>80)fail('feedback_version_invalid');
  if(!Array.isArray(body.images)||body.images.length>4)fail('feedback_images_invalid');
  const images=body.images.map(image=>{if(!image||Object.keys(image).some(k=>!['mime','bytes_base64'].includes(k))||image.mime!=='image/jpeg'||typeof image.bytes_base64!=='string'||image.bytes_base64.length>220000||! /^[A-Za-z0-9+/]*={0,2}$/.test(image.bytes_base64))fail('feedback_image_invalid');
   const bytes=Buffer.from(image.bytes_base64,'base64'),size=jpegDimensions(bytes);if(bytes.length<10||bytes.length>160*1024||bytes[0]!==255||bytes[1]!==216||bytes.at(-2)!==255||bytes.at(-1)!==217||!size||size.width<1||size.height<1||size.width>1600||size.height>1600)fail('feedback_image_invalid');return {bytes,sha256:createHash('sha256').update(bytes).digest('hex')};});
  return write(ctx,'feedback.submit',key,body,()=>{const id=randomUUID(),ts=now();const row=db.prepare('INSERT INTO employeeclient_feedback(id,actor_id,display_name,description,app_version,created_at) VALUES(?,?,?,?,?,?)').run(id,ctx.actor_id,ctx.display_name||ctx.actor_id,body.description.trim(),body.app_version,ts);
   for(const [position,image] of images.entries())db.prepare('INSERT INTO employeeclient_feedback_images VALUES(?,?,?,?,?)').run(id,position,'image/jpeg',image.bytes,image.sha256);
   return {state:'stored',feedback_id:id,feedback_no:Number(row.lastInsertRowid),created_at:ts,image_count:images.length};});
 }
 function list(ctx,{after=0,limit=30}={}){read(ctx);const cursor=Number(after),count=Number(limit);if(!Number.isSafeInteger(cursor)||cursor<0||!Number.isInteger(count)||count<1||count>100)fail('invalid_cursor');const rows=db.prepare('SELECT f.*, (SELECT COUNT(*) FROM employeeclient_feedback_images i WHERE i.feedback_id=f.id) image_count FROM employeeclient_feedback f WHERE seq>? ORDER BY seq LIMIT ?').all(cursor,count+1);const more=rows.length>count;return {feedback:rows.slice(0,count),has_more:more,next_cursor:more?rows[count-1].seq:null};}
 function detail(ctx,id){read(ctx);const row=db.prepare('SELECT * FROM employeeclient_feedback WHERE id=?').get(id);if(!row)fail('feedback_not_found',404);return {...row,images:db.prepare('SELECT position,mime,bytes,sha256 FROM employeeclient_feedback_images WHERE feedback_id=? ORDER BY position').all(id).map(image=>({position:image.position,mime:image.mime,size:image.bytes.length,sha256:image.sha256,data_url:'data:'+image.mime+';base64,'+Buffer.from(image.bytes).toString('base64')}))};}
 return {submit,list,detail};
}

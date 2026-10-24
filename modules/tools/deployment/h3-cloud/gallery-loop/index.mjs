import {createGalleryLoop} from './gallery-loop.mjs';
import {createGeneration} from './generation.mjs';
import {createReferenceLibrary} from './reference-library.mjs';
import {createGalleryTools} from './gallery-tools.mjs';
import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {readFile,mkdir,writeFile,rename,unlink,stat} from 'node:fs/promises';
import {existsSync,readFileSync} from 'node:fs';
import {resolve,join,extname,dirname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {gzipSync} from 'node:zlib';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const sha=s=>createHash('sha256').update(s).digest('hex');
const fail=(status,message)=>Object.assign(Error(message),{status});
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.jpg':'image/jpeg','.png':'image/png','.webp':'image/webp','.woff2':'font/woff2'};
const stamp=()=>new Date().toISOString();
function tar(files){const chunks=[];for(const f of files){const data=Buffer.from(f.body||''),h=Buffer.alloc(512);h.write(f.path,0,100);h.write('0000644\0',100);h.write('0000000\0',108);h.write('0000000\0',116);h.write(data.length.toString(8).padStart(11,'0')+'\0',124);h.write(Math.floor(Date.now()/1000).toString(8).padStart(11,'0')+'\0',136);h.fill(32,148,156);h.write('0',156);h.write('ustar\0',257);h.write('00',263);const sum=h.reduce((a,b)=>a+b,0);h.write(sum.toString(8).padStart(6,'0')+'\0 ',148);chunks.push(h,data,Buffer.alloc((512-data.length%512)%512))}chunks.push(Buffer.alloc(1024));return gzipSync(Buffer.concat(chunks))}
export async function createGallery({stateDir=process.env.STATE_DIR||join(ROOT,'.state'),authBase=process.env.AUTH_BASE||'http://127.0.0.1:4611',origin=process.env.PUBLIC_ORIGIN||'https://hufu.example.invalid/',comfyBase=process.env.COMFY_API_BASE,organization=process.env.ORGANIZATION_ID||'fa1d73b2-bf87-45c1-abef-b7739503819a'}={}){
 await mkdir(join(stateDir,'uploads'),{recursive:true,mode:0o700});const db=new DatabaseSync(join(stateDir,'gallery.sqlite'));db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS posts(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS comments(id TEXT PRIMARY KEY,post_id TEXT NOT NULL,user_id TEXT NOT NULL,author TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS saves(id TEXT PRIMARY KEY,post_id TEXT NOT NULL,user_id TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS skill_versions(skill_id TEXT NOT NULL,version TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(skill_id,version));
 CREATE INDEX IF NOT EXISTS comments_post ON comments(post_id);CREATE INDEX IF NOT EXISTS saves_user ON saves(user_id);`);
 const seed=JSON.parse(readFileSync(join(ROOT,'data/seed.json'),'utf8'));const skillSeed=JSON.parse(readFileSync(join(ROOT,'data/skills.json'),'utf8'));
 for(const s of skillSeed)for(const r of s.revisions)db.prepare('INSERT OR IGNORE INTO skill_versions(skill_id,version,body,created_at) VALUES(?,?,?,?)').run(s.id,r.version,JSON.stringify({...s,revisions:[r]}),r.date);
 const rawPosts=()=>[...db.prepare('SELECT body FROM posts ORDER BY created_at DESC').all().map(p=>JSON.parse(p.body)),...seed];
 function allSkills(){const map=new Map();for(const row of db.prepare('SELECT body FROM skill_versions ORDER BY created_at DESC,rowid DESC').all()){const s=JSON.parse(row.body);if(!map.has(s.id))map.set(s.id,{...s,revisions:[]});map.get(s.id).revisions.push(...s.revisions)}return [...map.values()].sort((a,b)=>{const rank=['video-generation','co-create-methodology','project-experience-distiller'];return (rank.includes(a.id)?rank.indexOf(a.id):999)-(rank.includes(b.id)?rank.indexOf(b.id):999)})}
 const library=createReferenceLibrary({db,rawPosts,origin});
 const allPosts=library.posts;
 const galleryTools=createGalleryTools({db,stateDir,allPosts,origin,organization,library});
 const callerTokens=new WeakMap();
 const generation=createGeneration({db,galleryTools,...(comfyBase?{base:comfyBase}:{})});
 const galleryLoop=createGalleryLoop({db,galleryTools,generation,library});
 async function identity(req){
  let token;const bearer=req.headers.authorization?.match(/^Bearer ([^\s]+)$/)?.[1];
  const galleryCookie=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('visual_lab_session='))?.slice('visual_lab_session='.length);
  const call=async(path,headers)=>{const r=await fetch(authBase+path,{headers,signal:AbortSignal.timeout(7000)});if(r.status===401||r.status===403)return null;if(!r.ok)throw fail(503,'成员登录服务暂时不可用');return r.json()};
  if(bearer)token=bearer;else if(galleryCookie&&/^[a-zA-Z0-9._~-]{1,512}$/.test(galleryCookie))token=galleryCookie;else if(req.headers.cookie){const s=await call('/v2/auth/get-session',{cookie:req.headers.cookie});if(s?.session?.token&&new Date(s.session.expiresAt)>new Date())token=s.session.token}
  if(!token)return null;
  const id=await call('/v2/me',{authorization:'Bearer '+token});if(!id)return null;if(id.organization_id!==organization)throw fail(403,'此空间仅供组织内部成员使用');
  const me={id:id.actor_id,name:id.member_label||id.member_profile?.profile?.nickname||'成员',admin:['organization_admin','owner'].includes(id.member_role)||id.member_profile?.current_role==='organization_admin'};callerTokens.set(me,token);return me;
 }
 const server=http.createServer(async(req,res)=>{
 const reply=(code,data,headers={})=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','X-Frame-Options':'SAMEORIGIN',...headers});res.end(Buffer.isBuffer(data)||typeof data==='string'?data:JSON.stringify(data))};
 try{
  const url=new URL(req.url,origin),path=url.pathname.replace(/^\/visual-lab/,'')||'/';
  if(path==='/health')return reply(200,{state:'ready',service:'visual-lab',version:'0.8.1'});
  // The shell is public; actual media, prompts, skill contents and member data require identity.
  const isShell=path==='/'||path==='/index.html'||path.startsWith('/assets/');
  const me=isShell?null:await identity(req);
  if(!isShell&&!me)return reply(401,{error:'请使用身份权限服务成员邮箱登录后访问内部学习空间。',login_required:true});
  if(['POST','PUT','DELETE'].includes(req.method)){
   if(req.headers.origin&&req.headers.origin!==origin)return reply(403,{error:'请求来源不符'});
   if(!req.headers.origin&&!req.headers.authorization)return reply(403,{error:'缺少同源请求来源'});
  }
  // Exchange a genuine Hufu browser session for a short-lived cookie scoped to this app.
  // Identity and organization above are always revalidated by Hufu, including on later reads.
  if(path==='/api/session'&&req.method==='POST'){
   const token=req.headers.authorization?.match(/^Bearer ([a-zA-Z0-9._~-]{1,512})$/)?.[1];
   if(!token)throw fail(401,'请先完成身份权限服务成员登录');
   return reply(200,{ok:true,user:me},{'Set-Cookie':`visual_lab_session=${token}; Path=/visual-lab/; HttpOnly; SameSite=Lax; Max-Age=28800${origin.startsWith('https:')?'; Secure':''}`});
  }
  if(path.startsWith('/api/loop/')&&req.method==='POST'){
   let size=0,chunks=[];for await(const c of req){size+=c.length;if(size>200000)throw fail(413,'请求过大');chunks.push(c)}
   let args;try{args=JSON.parse(Buffer.concat(chunks).toString())}catch{throw fail(400,'无效JSON')}
   return reply(200,await galleryLoop.invoke(decodeURIComponent(path.slice('/api/loop/'.length)),args,me,callerTokens.get(me)));
  }
  if(path.startsWith('/api/generation/')){
   const tail=path.slice('/api/generation/'.length),token=callerTokens.get(me);
   const readJSON=async()=>{let n=0,chunks=[];for await(const c of req){n+=c.length;if(n>200000)throw fail(413,'生成请求过大');chunks.push(c)}try{return JSON.parse(Buffer.concat(chunks).toString())}catch{throw fail(400,'生成请求JSON无效')}};
   if(tail==='capabilities'&&req.method==='GET')return reply(200,await generation.capabilities(token));
   if(tail==='preview'&&req.method==='POST')return reply(200,await generation.preview(await readJSON(),token));
   if(tail==='jobs'&&req.method==='POST')return reply(202,await generation.create(await readJSON(),me,token));
   if(tail==='jobs'&&req.method==='GET')return reply(200,{jobs:generation.list(me)});
   const job=tail.match(/^jobs\/([a-fA-F0-9-]+)(\/sync)?$/);
   if(job&&!job[2]&&req.method==='GET')return reply(200,{job:generation.get(job[1],me)});
   if(job&&job[2]&&req.method==='POST')return reply(200,{job:await generation.sync(job[1],me,token)});
   throw fail(404,'生成入口不存在');
  }
  if(path.startsWith('/api/tools/')&&req.method==='POST'){
   const action=path.slice('/api/tools/'.length);if(!['publish','list','get','annotate','keywords','keyword.link','recipe.save','recipe.list'].includes(action))throw fail(404,'未知画廊工具');
   let size=0;const chunks=[];for await(const c of req){size+=c.length;if(size>58*1024*1024)throw fail(413,'提交内容过大');chunks.push(c)}
   let args;try{args=JSON.parse(Buffer.concat(chunks).toString())}catch{throw fail(400,'无效JSON')}
   return reply(200,await galleryTools.invoke('gallery.'+action,args,me));
  }
  if(path==='/api/collaboration'&&req.method==='GET')return reply(200,JSON.parse(readFileSync(join(ROOT,'data/collaboration.json'),'utf8')));
  // Detailed production skills stay local during exploration, including old-version URLs.
  if(path==='/api/skills'||path.startsWith('/api/skills/'))return reply(410,{state:'withdrawn',error:'详细Skill暂留本地；请使用协作入口接续目标和提交成果。',next:'/visual-lab/api/collaboration'});
  if(path==='/api/gallery'&&req.method==='GET')return reply(200,{posts:allPosts(),comments:db.prepare('SELECT id,post_id,author,body,created_at FROM comments ORDER BY created_at ASC LIMIT 3000').all(),saved:db.prepare('SELECT post_id FROM saves WHERE user_id=?').all(me.id).map(s=>s.post_id),user:me});
  if(path==='/api/skills'&&req.method==='GET')return reply(200,{skills:allSkills()});
  if(path==='/api/gallery'&&req.method==='POST'){
   let n=0;const chunks=[];for await(const c of req){n+=c.length;if(n>42*1024*1024)throw fail(413,'上传内容超过42MB');chunks.push(c)}
   const form=await new Request(origin+req.url,{method:'POST',headers:{'content-type':req.headers['content-type']||''},body:Buffer.concat(chunks)}).formData();
   const action=String(form.get('action')||''),id=String(form.get('postId')||'');
   if(action==='comment'){
    const body=String(form.get('body')||'').trim();if(!allPosts().some(p=>p.id===id)||!body||body.length>2000)throw fail(400,'请填写有效作品与2000字以内的点评');
    db.prepare('INSERT INTO comments VALUES(?,?,?,?,?,?)').run(randomUUID(),id,me.id,me.name,body,stamp());return reply(200,{ok:true});
   }
   if(action==='save'){
    if(!allPosts().some(p=>p.id===id))throw fail(404,'作品不存在');const key=me.id+':'+id;
    if(db.prepare('SELECT id FROM saves WHERE id=?').get(key))db.prepare('DELETE FROM saves WHERE id=?').run(key);else db.prepare('INSERT INTO saves VALUES(?,?,?,?)').run(key,id,me.id,stamp());return reply(200,{ok:true});
   }
   if(action==='upload'){
    const jsonField=(name,fallback)=>{try{return form.get(name)?JSON.parse(String(form.get(name))):fallback}catch{throw fail(400,name+'格式无效')}};
    const referenceFiles=form.getAll('reference_files').filter(f=>typeof f.arrayBuffer==='function'&&f.size);if(referenceFiles.length>4)throw fail(400,'参考图最多4张');
    const referenceMetadata=jsonField('reference_metadata',[]);if(!Array.isArray(referenceMetadata))throw fail(400,'参考图设置格式无效');
    const referenceImages=[];for(const [i,ref] of referenceFiles.entries()){if(ref.size>8*1024*1024)throw fail(413,'参考图须在8MB以内');referenceImages.push({image_base64:Buffer.from(await ref.arrayBuffer()).toString('base64'),role:String(referenceMetadata[i]?.role||'未记录'),weight:String(referenceMetadata[i]?.weight||'未记录')})}
    const f=form.get('image');if(!f||typeof f.arrayBuffer!=='function'||!f.size||f.size>8*1024*1024)throw fail(400,'请选择8MB以内的图片');
    const model=String(form.get('model')||'');if(!['GPT','MJ','Krea 2'].includes(model))throw fail(400,'请选择模型');
    const result=await galleryTools.publish({title:String(form.get('title')||'').trim(),model,kind:String(form.get('kind')||'场景'),version:String(form.get('version')||'未知'),prompt:String(form.get('prompt')||''),negative_prompt:String(form.get('negative_prompt')||''),parameters:jsonField('parameters',{记录:String(form.get('params')||'未记录')}),note:String(form.get('note')||''),keywords:jsonField('keywords',[]),slices:jsonField('slices',[]),...(referenceImages.length?{reference_images:referenceImages}:{}),...(form.get('recipe_id')?{recipe_id:String(form.get('recipe_id'))}:{}),tags:String(form.get('tags')||'').split(/[,，]/).map(s=>s.trim()).filter(Boolean),...(form.get('idempotency_key')?{idempotency_key:String(form.get('idempotency_key'))}:{})},me,{bytes:Buffer.from(await f.arrayBuffer()),channel:'web'});
    return reply(200,{ok:true,id:result.post_id,...result});
   }
   throw fail(400,'未知操作');
  }
  if(path==='/api/skills'&&req.method==='POST'){
   if(!me.admin)throw fail(403,'仅主管可以发布Skill版本');let b='';for await(const c of req){b+=c;if(Buffer.byteLength(b)>2*1024*1024)throw fail(413,'Skill内容过大')}
   let input;try{input=JSON.parse(b)}catch{throw fail(400,'无效JSON')}
   const {id,version,body,prompt,note,expectedVersion}=input;if(!/^[a-z][a-z0-9-]{1,70}$/.test(id||'')||!version||String(version).length>80||typeof body!=='string'||!body.trim()||body.length>250000||typeof prompt!=='string'||!prompt.trim()||prompt.length>20000)throw fail(400,'请填写有效名称、版本、Skill内容及可用提示词');
   const current=allSkills().find(s=>s.id===id);if(current&&current.revisions[0].version!==expectedVersion)throw fail(409,'当前版本已更新，请刷新后再发布');if(current?.revisions.some(r=>r.version===version))throw fail(409,'此版本已存在，请使用新的版本号');
   const declared=body.match(/^---[\s\S]*?\n---/)?.[0].match(/version:\s*[\"']?([^\s\"']+)/)?.[1];if(declared&&declared!==version)throw fail(400,'Skill原文中的版本号与新版本号不一致');
   let files=current?current.revisions[0].files:[{path:'SKILL.md',body}];if(input.files!==undefined){if(!Array.isArray(input.files)||input.files.length>200)throw fail(400,'参考文件清单无效');files=input.files.map(f=>{if(typeof f.path!=='string'||f.path.startsWith('/')||f.path.split('/').includes('..')||f.path.includes('\\')||f.path.length>90||typeof f.body!=='string')throw fail(400,'参考文件路径或正文无效');return {path:f.path,body:f.body,sha256:sha(f.body)}});if(!files.some(f=>f.path==='SKILL.md'))throw fail(400,'完整包缺少SKILL.md')}
   const digest=sha(body),r={version,date:stamp(),body,prompt,note:String(note||'').slice(0,4000),sha256:digest,author:me.name,files:files.map(f=>f.path==='SKILL.md'?{...f,body,sha256:digest}:f)};
   const s={id,title:String(input.title||current?.title||id).slice(0,100),category:String(input.category||current?.category||'创作方法').slice(0,50),summary:String(input.summary||current?.summary||'').slice(0,1000),revisions:[r]};
   db.prepare('INSERT INTO skill_versions VALUES(?,?,?,?)').run(id,version,JSON.stringify(s),stamp());return reply(200,{ok:true,id,version,sha256:digest});
  }
  const skillPath=path.match(/^\/api\/skills\/([a-z0-9-]+)\/download$/);
  if(skillPath&&req.method==='GET'){
   const s=allSkills().find(s=>s.id===skillPath[1]),r=s?.revisions.find(r=>r.version===(url.searchParams.get('version')||s.revisions[0].version));if(!s||!r)throw fail(404,'版本不存在');
   const files=r.files.filter(f=>typeof f.body==='string'&&!f.path.split('/').includes('..')&&!f.path.startsWith('/')&&Buffer.byteLength(s.id+'/'+f.path)<100).map(f=>({...f,path:s.id+'/'+f.path}));
   return reply(200,tar(files),{'Content-Type':'application/gzip','Content-Disposition':`attachment; filename="${s.id}-${r.version.replace(/[^a-zA-Z0-9._-]/g,'_')}.tar.gz"`});
  }
  if(req.method!=='GET'&&req.method!=='HEAD')throw fail(405,'不支持此方法');
  let file;if(path.startsWith('/api/media/')){const key=path.slice('/api/media/'.length);if(!/^[a-f0-9-]+\.(jpg|png|webp)$/.test(key))throw fail(404,'文件不存在');file=join(stateDir,'uploads',key)}
  else{const base=path.startsWith('/art/')?join(ROOT,'public'):join(ROOT,'dist');const target=path==='/'?'/index.html':decodeURIComponent(path);file=resolve(base,'.'+target);if(!file.startsWith(base+sep))throw fail(404,'文件不存在')}
  try{const b=await readFile(file);return reply(200,req.method==='HEAD'?'':b,{'Content-Type':MIME[extname(file)]||'application/octet-stream','Cache-Control':isShell&&path.startsWith('/assets/')?'public,max-age=86400':'private,no-cache'})}catch(e){if(e.code==='ENOENT')throw fail(404,'文件不存在');throw e}
 }catch(e){reply(e.status||500,{error:e.status?e.message:'操作失败，请保留输入并稍后重试。'})}
 });
 return {server,db,close:async()=>{await generation.close();return new Promise(resolve=>server.close(()=>{db.close();resolve()}))}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const app=await createGallery();const port=Number(process.env.PORT||18310);app.server.listen(port,'127.0.0.1',()=>console.log('visual-lab ready on loopback:'+port));}

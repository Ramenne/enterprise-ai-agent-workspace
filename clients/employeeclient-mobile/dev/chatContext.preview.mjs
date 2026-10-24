// Loopback-only synthetic UI fixture. No production account, data or outbound RPC.
import {startQuoteReturnPreview} from './quoteReturn.preview.mjs';
import {PROJECT} from '../server/business/native-authority.mjs';
import {createHash} from 'node:crypto';
const port=Number(process.env.QN_CONTEXT_PORT||5391);
const origin='http://'+(process.env.QN_CONTEXT_HOST||'127.0.0.1')+':'+port;
const longImageId='e4b2230b-4b0b-46f9-a9e9-4f90fa624b8b';
const fixture=startQuoteReturnPreview(port,({scenario,ctx,members})=>{
 const repo=scenario.repository,db=scenario.db;
 const original=repo.get(ctx,db.prepare("SELECT id FROM messages WHERE body='昨天的原始内容'").get().id);
 const imageBytes=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="2400"><rect width="160" height="2400" fill="#9dcabe"/><text x="10" y="80">LOCAL LONG IMAGE</text><text x="10" y="2300">END</text></svg>');
 const image={material_id:longImageId,version_id:'b2d1d4d7-e22d-43b7-a647-27b7f4f3cb88',project_id:PROJECT,logical_path:'模拟图片/上下文长图.svg',size:imageBytes.length,sha256:createHash('sha256').update(imageBytes).digest('hex')};
 scenario.registerSourceFile(image,imageBytes);
 for(let i=0;i<2600;i++){
  if(i===1200)repo.send(ctx,{body:'原话前的延迟长图'},'context-long-image',{members,attachments:[{...image,id:image.material_id+':'+image.version_id,name:'上下文长图.svg',mime:'image/svg+xml',purpose:'file',ver:1,owner_username:'sim-b',fixed_ref:image}]});
  repo.send(ctx,{body:'深历史中间记录 '+i},'deep-'+i,{members});
 }
 const duplicate=repo.send(ctx,{body:'昨天的原始内容'},'duplicate',{members}).message;
 const quoted=repo.send(ctx,{body:'深历史引用验证',reply_to_id:original.id},'deep-quote',{members}).message;
 const pageTarget=repo.get(ctx,db.prepare("SELECT id FROM messages WHERE body='深历史中间记录 1200'").get().id);
 const pageQuote=repo.send(ctx,{body:'分页上下文验证',reply_to_id:pageTarget.id},'page-quote',{members}).message;
 for(let i=0;i<65;i++)repo.send({...ctx,actor_id:i%2?'sim-a':'sim-b'},{body:'组合检索 https://example.com/'+i,mention_usernames:i%3===0?['sim-a']:[]},'link-'+i,{members});
 const attachment={id:'4bbf924c-a36c-4a86-ac04-7effd6c51110:b2d1d4d7-e22d-43b7-a647-27b7f4f3cb88',name:'分类样本.txt',mime:'text/plain',purpose:'file',size:20,sha256:'a'.repeat(64),owner_username:'sim-b',fixed_ref:{project_id:PROJECT,material_id:'4bbf924c-a36c-4a86-ac04-7effd6c51110',version_id:'b2d1d4d7-e22d-43b7-a647-27b7f4f3cb88'}};
 repo.send(ctx,{body:'组合检索普通文件'},'file',{members,attachments:[attachment]});
 repo.send({...ctx,actor_id:'sim-a'},{body:'助手链接 https://example.com/self',recipient_username:'sim-a'},'helper-link',{members});
 return {duplicate,deepQuote:quoted,pageTarget,pageQuote};
},{host:process.env.QN_CONTEXT_HOST||'127.0.0.1'});
const metrics=[],held=[],heldImages=[];let hold=false,failTarget=false,failQuery=false,failPage=false,holdPage=false,holdImages=true;
const handler=fixture.server.listeners('request')[0];fixture.server.removeAllListeners('request');
fixture.server.on('request',(req,res)=>{
 const url=new URL(req.url,origin);
 if(url.pathname==='/native/file')res.once('finish',()=>metrics.push({route:'native-file',status:res.statusCode}));
 if(url.pathname==='/simulation/context-control'){
  const mode=url.searchParams.get('mode');
  if(mode==='hold')hold=true;
  if(mode==='release'){hold=false;for(const run of held.splice(0))run();}
  if(mode==='fail-target')failTarget=true;
  if(mode==='fail-query')failQuery=true;
  if(mode==='fail-page')failPage=true;
  if(mode==='hold-page')holdPage=true;
  if(mode==='release-page'){holdPage=false;for(const run of held.splice(0))run();}
  if(mode==='release-images'){holdImages=false;for(const run of heldImages.splice(0))run();}
  if(mode==='clear')metrics.splice(0);
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({scope:'synthetic loopback fixture only',held:held.length,heldImages:heldImages.length,metrics,original:fixture.original.id,duplicate:fixture.duplicate.id,deepQuote:fixture.deepQuote.id,pageTarget:fixture.pageTarget.id,pageQuote:fixture.pageQuote.id}));return;
 }
 if(url.pathname.startsWith('/business/v1/messages'))metrics.push(url.pathname+url.search);
 const isOriginal=url.pathname==='/business/v1/messages/'+fixture.original.id;
 if(isOriginal&&failTarget){failTarget=false;res.writeHead(404,{'content-type':'application/json'});res.end(JSON.stringify({error_code:'message_not_found',error:'message_not_found'}));return;}
 if(url.pathname==='/business/v1/messages'&&url.searchParams.get('kind')&&failQuery){failQuery=false;res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error_code:'unavailable'}));return;}
 const isPage=url.pathname==='/business/v1/messages'&&(url.searchParams.has('before')||url.searchParams.has('after'));
 if(isPage&&failPage){failPage=false;res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error_code:'unavailable'}));return;}
 if(isPage&&holdPage){held.push(()=>{if(!res.destroyed)handler(req,res);});return;}
 if(url.pathname==='/native/file'&&url.searchParams.get('material_id')===longImageId&&holdImages){heldImages.push(()=>{if(!res.destroyed)handler(req,res);});return;}
 if(isOriginal&&hold){held.push(()=>{if(!res.destroyed)handler(req,res);});return;}
 handler(req,res);
});
console.log(JSON.stringify({state:'listening',origin,scope:'synthetic loopback fixture only'}));
const stop=()=>{hold=false;for(const run of held.splice(0))run();fixture.server.closeAllConnections();fixture.server.close(()=>process.exit(0));};
process.on('SIGINT',stop);process.on('SIGTERM',stop);

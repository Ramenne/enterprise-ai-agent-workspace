// Local-only integration: actual client/runtime/private AES-GCM and messages,
// with an in-memory Mem provider. No credentials or external network.
import {createHash,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {createLocalScenario} from './reconstruction-local.mjs';
import {createGateway} from '../server/gateway.mjs';
import {createSmallMediaHandler} from '../server/business/small-media.mjs';
import {createPrivateAttachments} from '../server/business/private-attachments.mjs';
import {PROJECT} from '../server/business/native-authority.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
export function startMediaForwardPreview(port=5252,{host='127.0.0.1'}={}){
 const ops=new Map(),files=new Map(),readFault={id:'',remaining:0,rejected:0,calls:[]};
 const providerRpc=async(a,name,args)=>{const f=files.get(args.material_id);if(!f)return undefined;if(args.project_id!==PROJECT)throw Object.assign(Error('forbidden'),{status:403});if(name==='mem.material.head')return {properties:f.properties,placements:[{logical_path:f.name}],fixed_ref:f.fixed};if(name==='mem.version.read'){if(args.version_id!==f.fixed.version_id)throw Object.assign(Error('not_found'),{status:404});const start=args.offset||0,end=Math.min(f.bytes.length,start+(args.limit||131072)),chunk=f.bytes.subarray(start,end);return {fixed_ref:f.fixed,bytes_base64:chunk.toString('base64'),chunk_sha256:sha(chunk),range:{start,end_exclusive:end},next_offset:end===f.bytes.length?null:end};}};
 const scenario=createLocalScenario({providerRpc}),origin='http://'+host+':'+port,privateAttachments=createPrivateAttachments(scenario.db);let puts=0;
 const members=['sim-a','sim-b','sim-m'].map(actor_id=>({actor_id,can_read:true,can_write:true}));
 const actor=cookie=>/simulation_member=(sim-[abm])/.exec(cookie||'')?.[1];
 const ctx=a=>({actor_id:a,display_name:a,can_read:!!a,can_write:!!a,project_id:PROJECT,member_roster:members});
 const remember=(bytes,name,mime,properties={})=>{const fixed={project_id:PROJECT,material_id:randomUUID(),version_id:randomUUID(),size:bytes.length,sha256:sha(bytes),local_version_no:'1'};files.set(fixed.material_id,{bytes,fixed,name,mime,properties});return fixed;};
 const sessionFactory=async cookie=>{const a=actor(cookie);if(!a)throw Object.assign(Error('login_required'),{status:401});return {context:ctx(a),directory:async()=>members,
  rpc:async(name,args)=>{
   if(name==='mem.upload.begin'){const op={...args,operation_id:randomUUID()};ops.set(op.operation_id,op);return op;}
   const op=ops.get(args.operation_id);
   if(name==='mem.upload.ticket')return {state:'uploading',size:op.size,ticket:{method:'PUT',url:'https://local-provider.invalid/'+op.operation_id,required_headers:{}}};
   if(name==='mem.upload.put_status')return {state:op.bytes?'completed':'uploading'};
   if(name==='mem.upload.put_complete'){if(!op.bytes||sha(op.bytes)!==op.sha256||op.bytes.length!==op.size)throw Error('invalid uploaded bytes');return {};}
   if(name==='mem.upload.publish'){op.fixed ||=remember(op.bytes,decodeURIComponent(op.logical_path.split('/').at(-1)),op.properties.employeeclient.mime,op.properties);return {state:'published',fixed_refs:[op.fixed]};}
   throw Error('unsupported local provider: '+name);
  },fileStream:async fixed=>{const f=files.get(fixed.material_id);if(!f||f.fixed.version_id!==fixed.version_id||f.fixed.sha256!==fixed.sha256)throw Error('local fixed file mismatch');return new Response(f.bytes);}
 };};
 const small=createSmallMediaHandler({db:scenario.db,repository:scenario.repository,privateAttachments,sessionFactory,reference:async()=>null,changed:()=>{},fetcher:async(url,options)=>{const op=ops.get(new URL(url).pathname.slice(1));if(!op)throw Error('unknown operation');op.bytes=Buffer.from(options.body);puts++;return new Response('',{status:200});}});
 const businessHandler=async(req,res)=>{
  const path=new URL(req.url,origin).pathname;
  if(req.method==='POST'&&path.endsWith('/read'))readFault.calls.push({path,actor:actor(req.headers.cookie),remaining:readFault.remaining});
  if(req.method==='POST'&&path==='/business/v1/notifications/'+readFault.id+'/read'&&readFault.remaining>0){readFault.remaining--;readFault.rejected++;res.writeHead(503,{'content-type':'application/json'});res.end('{"error_code":"upstream_unavailable"}');return true;}
  if(path==='/business/v1/media-transfers')return small(req,res);
  const match=/^\/business\/v1\/private-attachments\/([^/]+)(\/file)?$/.exec(path);
  if(match&&req.method==='GET'){
   try{const session=await sessionFactory(req.headers.cookie);
    if(match[2]){const controller=new AbortController();res.once('close',()=>{if(!res.writableEnded)controller.abort();});await privateAttachments.stream(session.context,decodeURIComponent(match[1]),session,res,controller.signal);res.end();}
    else{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(privateAttachments.head(session.context,decodeURIComponent(match[1]))));}
   }catch(e){if(!res.headersSent){res.writeHead(e.status||503,{'content-type':'application/json'});res.end(JSON.stringify({error_code:e.code||'local_source_unavailable'}));}}
   return true;
  }
  return scenario.businessHandler(req,res);
 };
 const fetcher=async(url,options={})=>{const target=new URL(url),path=target.pathname;
  if(target.hostname==='local-provider.invalid'){const op=ops.get(path.slice(1));if(!op)throw Error('unknown operation');let total=0;const chunks=[];for await(const chunk of options.body){const bytes=Buffer.from(chunk);total+=bytes.length;if(total>op.size)throw Error('fixture upload exceeds declared size');chunks.push(bytes);}if(total!==op.size)throw Error('fixture upload incomplete');op.bytes=Buffer.concat(chunks,total);puts++;return new Response('',{status:200});}
  const upload=/\/uploads(?:\/([^/]+)\/(put-ticket|put\/status|put\/complete|publish))?$/.exec(path);
  if(upload){const a=options.headers?.authorization?.replace('Bearer local-simulation:','')||actor(options.headers?.cookie);if(!members.some(m=>m.actor_id===a))return new Response('{}',{status:401});const args=JSON.parse(options.body||'{}');if(args.project_id!==PROJECT)return new Response('{}',{status:403});if(upload[1])args.operation_id=upload[1];const session=await sessionFactory('simulation_member='+a),name=upload[2]?{'put-ticket':'ticket','put/status':'put_status','put/complete':'put_complete',publish:'publish'}[upload[2]]:'begin';const existing=ops.get(args.operation_id);if(existing&&existing.actor_id!==a)return new Response('{}',{status:403});const result=await session.rpc('mem.upload.'+name,args);if(name==='begin')ops.get(result.operation_id).actor_id=a;return new Response(JSON.stringify(result),{headers:{'content-type':'application/json'}});}
 if(path.endsWith('/files/read')){const args=JSON.parse(options.body||'{}'),f=files.get(args.material_id);if(f&&f.fixed.version_id===args.version_id)return new Response(f.bytes,{headers:{'content-type':'application/octet-stream','x-hub-read-receipt':'local-simulation-only'}});}return scenario.fetcher(url,options);};
 const server=createGateway({root:resolve('dist'),publicOrigin:origin,businessHandler,fetcher}),handler=server.listeners('request')[0];server.removeAllListeners('request');
 server.on('request',async(req,res)=>{
  const path=new URL(req.url,origin).pathname;
  const match=/^\/simulation\/(sim-[abm])$/.exec(path);if(match){res.writeHead(302,{'set-cookie':`simulation_member=${match[1]}; HttpOnly; SameSite=Lax; Path=/`,location:'/#/chat'});res.end();return;}
  if(path==='/native/session'){const a=actor(req.headers.cookie);res.writeHead(a?200:401,{'content-type':'application/json'});res.end(JSON.stringify(a?{identity:{actor_id:a,member_label:a},user:{name:a},cache_partition:{actor_id:a},persistent_login:true}:{error_code:'login_required'}));return;}
  if(path==='/simulation/combine'&&req.method==='POST'){
   try{let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>4096)throw Error('fixture too large');}const input=JSON.parse(raw),a=actor(req.headers.cookie);if(!a)throw Error('actor missing');const attachments=input.ids.flatMap(id=>scenario.repository.get(ctx(a),id).attachments);if(attachments.length>6)throw Error('fixture too large');const receipt=scenario.repository.send(ctx(a),{body:input.caption,mention_usernames:[]},'combine-'+randomUUID(),{members,attachments});res.writeHead(201,{'content-type':'application/json'});res.end(JSON.stringify(receipt));}catch(e){res.writeHead(400);res.end(String(e));}return;
  }
  if(path==='/simulation/seed-file'&&req.method==='POST'){
   try{let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>4*1024*1024)throw Error('fixture too large');}const input=JSON.parse(raw),a=actor(req.headers.cookie),bytes=Buffer.from(input.base64,'base64');if(!a)throw Error('actor missing');const metadata={purpose:input.purpose==='voice'?'voice':'file',...(input.duration_ms?{duration_ms:input.duration_ms}:{})};const fixed=remember(bytes,input.name,input.mime,{employeeclient:metadata});
    const attachment={id:fixed.material_id+':'+fixed.version_id,name:input.name,mime:input.mime,size:bytes.length,sha256:fixed.sha256,ver:1,fixed_ref:fixed,...metadata};
    const receipt=scenario.repository.send(ctx(a),{body:input.caption||'',mention_usernames:[]},'seed-'+fixed.material_id,{members,attachments:[attachment]});res.writeHead(201,{'content-type':'application/json'});res.end(JSON.stringify(receipt));
   }catch(e){res.writeHead(400);res.end(String(e));}return;
  }
  if(path==='/simulation/media-stats'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({puts,operations:ops.size,messages:scenario.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n}));return;}
  handler(req,res);
 });server.qaState=()=>scenario.repository.notifications(ctx('sim-b'),0,100);server.qaReadFailures=readFault;server.on('close',()=>scenario.close());server.listen(port,'127.0.0.1');return server;
}

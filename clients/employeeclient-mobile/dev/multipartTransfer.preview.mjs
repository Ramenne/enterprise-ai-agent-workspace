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
export function startMultipartPreview(port=5252,{host='127.0.0.1'}={}){
 const ops=new Map(),files=new Map();
 const providerRpc=async(a,name,args)=>{const f=files.get(args.material_id);if(!f)return undefined;if(args.project_id!==PROJECT)throw Object.assign(Error('forbidden'),{status:403});if(name==='mem.material.head')return {properties:f.properties,placements:[{logical_path:f.name}],fixed_ref:f.fixed};if(name==='mem.version.read'){if(args.version_id!==f.fixed.version_id)throw Object.assign(Error('not_found'),{status:404});const start=args.offset||0,end=Math.min(f.bytes.length,start+(args.limit||131072)),chunk=f.bytes.subarray(start,end);return {fixed_ref:f.fixed,bytes_base64:chunk.toString('base64'),chunk_sha256:sha(chunk),range:{start,end_exclusive:end},next_offset:end===f.bytes.length?null:end};}};
 const scenario=createLocalScenario({providerRpc}),origin='http://'+host+':'+port,privateAttachments=createPrivateAttachments(scenario.db);let puts=0;let failPart=2;const attempts=[];
 const members=['sim-a','sim-b','sim-m'].map(actor_id=>({actor_id,can_read:true,can_write:true}));
 const actor=cookie=>/simulation_member=(sim-[abm])/.exec(cookie||'')?.[1];
 const ctx=a=>({actor_id:a,display_name:a,can_read:!!a,can_write:!!a,project_id:PROJECT,member_roster:members});
 const remember=(bytes,name,mime,properties={})=>{const fixed={project_id:PROJECT,material_id:randomUUID(),version_id:randomUUID(),size:bytes.length,sha256:sha(bytes),local_version_no:'1'};files.set(fixed.material_id,{bytes,fixed,name,mime,properties});return fixed;};
 const sessionFactory=async cookie=>{const a=actor(cookie);if(!a)throw Object.assign(Error('login_required'),{status:401});return {context:ctx(a),directory:async()=>members,
  rpc:async(name,args)=>{
   if(name==='mem.upload.begin'){const op={...args,operation_id:randomUUID()};ops.set(op.operation_id,op);return op;}
   const op=ops.get(args.operation_id);
   if(name==='mem.upload.multipart.begin'){op.parts ||=new Map();op.part_size=args.part_size;return {state:'uploading',part_size:op.part_size};}
   if(name==='mem.upload.multipart.resume')return {state:op.multipartComplete?'completed':'uploading',part_size:op.part_size,parts:[...op.parts].map(([part_number,bytes])=>({part_number,size:bytes.length,etag:sha(bytes)}))};
   if(name==='mem.upload.multipart.part_ticket')return {state:'uploading',ticket:{method:'PUT',url:'https://local-provider.invalid/'+op.operation_id+'?part='+args.part_number,required_headers:{}}};
   if(name==='mem.upload.multipart.complete'){const buffers=[...op.parts].sort((a,b)=>a[0]-b[0]).map(p=>p[1]);op.bytes=Buffer.concat(buffers);if(op.bytes.length!==op.size||sha(op.bytes)!==op.sha256)throw Error('multipart integrity mismatch');op.multipartComplete=true;return {state:'completed'};}

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
  if(target.hostname==='local-provider.invalid'){const op=ops.get(path.slice(1));if(!op)throw Error('unknown operation');const number=Number(target.searchParams.get('part'))||0,expected=number?Math.min(op.part_size,op.size-(number-1)*op.part_size):op.size;let total=0;const chunks=[];for await(const chunk of options.body){const bytes=Buffer.from(chunk);total+=bytes.length;if(total>expected)throw Error('fixture upload exceeds declared size');chunks.push(bytes);}if(total!==expected)throw Error('fixture upload incomplete');const received=Buffer.concat(chunks,total);if(number)op.parts.set(number,received);else op.bytes=received;puts++;return new Response('',{status:200});}
  const upload=/\/uploads(?:\/([^/]+)\/(put-ticket|put\/status|put\/complete|publish|multipart\/begin|multipart\/resume|multipart\/part-ticket|multipart\/complete))?$/.exec(path);
  if(upload){const a=options.headers?.authorization?.replace('Bearer local-simulation:','')||actor(options.headers?.cookie);if(!members.some(m=>m.actor_id===a))return new Response('{}',{status:401});const args=JSON.parse(options.body||'{}');if(args.project_id!==PROJECT)return new Response('{}',{status:403});if(upload[1])args.operation_id=upload[1];const session=await sessionFactory('simulation_member='+a),name=upload[2]?{'put-ticket':'ticket','put/status':'put_status','put/complete':'put_complete',publish:'publish','multipart/begin':'multipart.begin','multipart/resume':'multipart.resume','multipart/part-ticket':'multipart.part_ticket','multipart/complete':'multipart.complete'}[upload[2]]:'begin';const existing=ops.get(args.operation_id);if(existing&&existing.actor_id!==a)return new Response('{}',{status:403});const result=await session.rpc('mem.upload.'+name,args);if(name==='begin')ops.get(result.operation_id).actor_id=a;return new Response(JSON.stringify(result),{headers:{'content-type':'application/json'}});}
 if(path.endsWith('/files/read')){const args=JSON.parse(options.body||'{}'),f=files.get(args.material_id);if(f&&f.fixed.version_id===args.version_id)return new Response(f.bytes,{headers:{'content-type':'application/octet-stream','x-hub-read-receipt':'local-simulation-only'}});}return scenario.fetcher(url,options);};
 const server=createGateway({root:resolve('dist'),publicOrigin:origin,businessHandler,fetcher}),handler=server.listeners('request')[0];server.removeAllListeners('request');
 server.on('request',async(req,res)=>{
  const incoming=new URL(req.url,origin),path=incoming.pathname;
  if(path==='/native/upload'){
   const number=Number(incoming.searchParams.get('part_number')),effectHead=res.writeHead.bind(res),effectEnd=res.end.bind(res);let concealed=false;
   res.writeHead=(status,...rest)=>{if(status===200&&number===failPart){failPart=0;concealed=true;status=503;}attempts.push({operation:incoming.searchParams.get('operation_id'),number,effectStatus:concealed?200:status,returnedStatus:status,size:Number(incoming.searchParams.get('size'))});return effectHead(status,...rest);};
   res.end=(chunk,...rest)=>effectEnd(concealed?JSON.stringify({error_code:'synthetic_part_receipt_lost'}):chunk,...rest);
  }
  if(path==='/simulation/multipart-stats'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({scope:'synthetic multipart provider only',puts,attempts,operations:[...ops.values()].map(op=>({id:op.operation_id,size:op.size,parts:[...(op.parts||[])].map(([number,bytes])=>({number,size:bytes.length,sha256:sha(bytes)})),sha256:op.bytes&&sha(op.bytes),complete:!!op.multipartComplete,fixed:op.fixed}))}));return;}
  const match=/^\/simulation\/(sim-[abm])$/.exec(path);if(match){res.writeHead(302,{'set-cookie':`simulation_member=${match[1]}; HttpOnly; SameSite=Lax; Path=/`,location:'/#/chat'});res.end();return;}
  if(path==='/native/session'){const a=actor(req.headers.cookie);res.writeHead(a?200:401,{'content-type':'application/json'});res.end(JSON.stringify(a?{identity:{actor_id:a,member_label:a},user:{name:a},cache_partition:{actor_id:a},persistent_login:true}:{error_code:'login_required'}));return;}
  if(path==='/simulation/seed-file'&&req.method==='POST'){
   try{let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>4*1024*1024)throw Error('fixture too large');}const input=JSON.parse(raw),a=actor(req.headers.cookie),bytes=Buffer.from(input.base64,'base64');if(!a)throw Error('actor missing');const fixed=remember(bytes,input.name,input.mime);
    const attachment={id:fixed.material_id+':'+fixed.version_id,name:input.name,mime:input.mime,size:bytes.length,sha256:fixed.sha256,ver:1,fixed_ref:fixed,purpose:'file'};
    const receipt=scenario.repository.send(ctx(a),{body:input.caption||'',mention_usernames:[]},'seed-'+fixed.material_id,{members,attachments:[attachment]});res.writeHead(201,{'content-type':'application/json'});res.end(JSON.stringify(receipt));
   }catch(e){res.writeHead(400);res.end(String(e));}return;
  }
  if(path==='/simulation/media-stats'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({puts,operations:ops.size,messages:scenario.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n}));return;}
  handler(req,res);
 });server.on('close',()=>scenario.close());server.listen(port,'127.0.0.1');return server;
}

const server=startMultipartPreview(5411,{host:'transfer-check.localhost'});
console.log('SYNTHETIC MULTIPART http://transfer-check.localhost:5411/simulation/sim-a');
const stop=()=>{server.closeAllConnections();server.close(()=>process.exit(0));};process.on('SIGINT',stop);process.on('SIGTERM',stop);

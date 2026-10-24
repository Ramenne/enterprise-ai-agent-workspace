import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {integrationOperations,validateIntegrationInput} from '../../shared/integration-contract.mjs';
import {createBusinessHandler} from './http.mjs';
import {createSmallMediaHandler} from './small-media.mjs';
import {coalesceNativeSessions,PROJECT,assertBusinessWrite} from './native-authority.mjs';
const fail=(code,status=400)=>{throw Object.assign(Error(code),{code,status});};
const sha=b=>createHash('sha256').update(b).digest('hex');
const LIMIT=2*1024*1024;
// The facade translates HTTP input only. Message commits, private encryption,
// idempotency and notification outbox remain the existing product use cases.
export function createIntegrationHandler({db,sessionFactory,repository,privateAttachments,reference,attachments,changed,fetcher=globalThis.fetch}){
 const sessions=coalesceNativeSessions(sessionFactory,{ttlMs:60000});
 const credential=req=>req.headers.authorization||'';
 const small=createSmallMediaHandler({db,sessionFactory:sessions,repository,privateAttachments,reference,changed,fetcher,credential});
 let active=0;
 const handler=async(req,res)=>{
  const url=new URL(req.url,'http://localhost'),prefix='/business/v1/integration';
  if(url.pathname!==prefix&&!url.pathname.startsWith(prefix+'/'))return false;
  let reserved=false;const ctl=new AbortController(),abort=()=>ctl.abort();req.once('aborted',abort);const close=()=>{if(!res.writableEnded)abort();};res.once('close',close);
  const timer=setTimeout(()=>{abort();if(!res.headersSent)reply(408,{error_code:'integration_request_timeout'});req.destroy();},120000);timer.unref?.();
  const reply=(status,value)=>{if(!res.destroyed&&!res.writableEnded){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));}};
  try{
   if(!['GET','POST'].includes(req.method))fail('method_not_allowed',405);
   if(active>=8)fail('integration_busy',429);active++;reserved=true;
   const relative=url.pathname.slice(prefix.length),detail=/^\/messages\/([^/]+)$/.exec(relative);
   const operation=integrationOperations.find(x=>x.method===req.method&&(x.path===relative||x.name==='message'&&detail));
   if(relative&& !operation)fail('integration_route_not_found',404);
   if(!relative&&req.method!=='GET')fail('method_not_allowed',405);
   let a={};
   if(req.method==='POST'){
    let size=0,chunks=[];for await(const c of req){size+=c.length;if(size>65536)fail('request_too_large',413);chunks.push(c);}
    try{a=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('invalid_json');}
    if(url.search)fail('integration_arguments_invalid');
   }else{
    if([...url.searchParams.keys()].some(k=>url.searchParams.getAll(k).length!==1))fail('integration_arguments_invalid');
    a=Object.fromEntries(url.searchParams);for(const k of ['before','after','limit'])if(a[k]!==undefined){if(!/^\d+$/.test(a[k]))fail('integration_arguments_invalid');a[k]=Number(a[k]);}
    if(detail)a.message_id=decodeURIComponent(detail[1]);
   }
   if(operation)validateIntegrationInput(operation.name,a);else if(Object.keys(a).length)fail('integration_arguments_invalid');
   let key;if(req.method==='POST'){key=req.headers['idempotency-key'];if(typeof key!=='string'||!/^[A-Za-z0-9_.:-]{1,160}$/.test(key))fail('idempotency_key_required');}
   ctl.signal.throwIfAborted();
   const auth=credential(req);let session=await sessions(auth);const actor=session.context.actor_id;
   if(!operation){reply(200,{base_path:prefix,authentication:'Authorization: Bearer <current member credential>',write_header:'Idempotency-Key: <stable submission key>',default_target:'assistant',operations:integrationOperations});return true;}
   const peer=a.target===undefined||a.target==='assistant'?actor:a.target==='group'?'':a.target;
   const message={body:a.body||'',attachment_ids:[],mention_usernames:[],...(peer?{recipient_username:peer}:{}),...(a.reply_to_id?{reply_to_id:a.reply_to_id}:{})};
   let path,method='GET',body;
   if(operation.name==='members')path='/members';
   if(operation.name==='conversations')path='/conversations';
   if(operation.name==='message')path='/messages/'+encodeURIComponent(a.message_id);
   if(operation.name==='messages'){const q=new URLSearchParams({...(peer?{peer}:{})});for(const k of ['q','before','after','limit'])if(a[k]!==undefined)q.set(k,String(a[k]));path='/messages?'+q;}
   if(operation.name==='send'){path='/messages';method='POST';body=Buffer.from(JSON.stringify(message));}
   if(operation.name==='send_file'){
    assertBusinessWrite(session.context,{});
    if(peer&&!(session.context.member_roster||await session.directory()).some(m=>m.actor_id===peer&&m.can_read===true))fail('recipient_unavailable',403);
    const page=await session.rpc('mem.version.read',{project_id:PROJECT,material_id:a.material_id,version_id:a.version_id,offset:0,limit:1,encoding:'base64'});
    const fixed=page.fixed_ref;if(!fixed||fixed.material_id!==a.material_id||fixed.version_id!==a.version_id||fixed.sha256!==a.sha256||fixed.project_id&&fixed.project_id!==PROJECT)fail('file_reference_changed',409);
    if(!Number.isSafeInteger(fixed.size)||fixed.size<1||fixed.size>LIMIT)fail('integration_file_size_limit',413);
    // Reject encrypted internal storage as an AI source. Callers must use their original file.
    const head=await session.rpc('mem.material.head',{project_id:PROJECT,material_id:a.material_id});
    if(head.properties?.employeeclient?.internal_encrypted)fail('encrypted_source_not_supported',400);
    const response=await session.fileStream({...fixed,project_id:PROJECT},ctl.signal);
    if(!response.ok||!response.body)fail('file_read_unavailable',502);
    const reader=response.body.getReader(),parts=[];let length=0;
    try{for(;;){ctl.signal.throwIfAborted();const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>fixed.size||length>LIMIT)fail('file_length_mismatch',502);parts.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    const bytes=Buffer.concat(parts);if(length!==fixed.size||sha(bytes)!==a.sha256)fail('file_integrity_mismatch',502);
    const header=Buffer.from(JSON.stringify({file:{name:a.name,mime:a.mime,size:length,sha256:a.sha256,purpose:'file'},peer,message})),prefix=Buffer.alloc(4);prefix.writeUInt32BE(header.length);
    // Namespaced submission key cannot collide with a text send or UI submission.
    if(header.length>2000)fail('integration_file_caption_too_long',400);
    ctl.signal.throwIfAborted();
    const synthetic=Readable.from([prefix,header,bytes]);synthetic.url='/business/v1/media-transfers';synthetic.method='POST';synthetic.headers={authorization:auth,'idempotency-key':'integration-file:'+key};
    return await small(synthetic,res);
   }
   const synthetic=Readable.from(body?[body]:[]);synthetic.url='/business/v1'+path;synthetic.method=method;synthetic.headers={authorization:auth,...(key?{'idempotency-key':'integration-text:'+key}:{})};
   const authorize=async()=>{session=await sessions(auth);if(session.context.actor_id!==actor)fail('identity_changed',401);return session.context;};
   const standard=createBusinessHandler({repository,authorize,credential,directory:async()=>session.context.member_roster||session.directory(),resolveReference:(ctx,b,c)=>reference(ctx,b,c,session),resolveAttachments:(ctx,b,c)=>attachments(ctx,b,c,session),onChange:changed});
   ctl.signal.throwIfAborted();
   await standard(synthetic,res);return true;
  }catch(e){reply(Number.isInteger(e.status)?e.status:503,{error_code:e.code||'integration_dependency_unavailable'});return true;}
  finally{if(reserved)active--;clearTimeout(timer);req.off('aborted',abort);res.off('close',close);}
 };
 return handler;
}

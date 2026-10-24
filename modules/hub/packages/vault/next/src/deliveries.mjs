import {infrastructureFailure} from '../../../platform/src/failure-contract.mjs';
import {createHash,createHmac,randomInt,randomUUID} from 'node:crypto';
import {otpMailGateway} from '../../../member-auth/src/mail.mjs';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BYTES=256*1024;
export const codeMAC=(key,id,code)=>createHmac('sha256',key).update('vault-delivery:'+id+':'+code).digest('hex');
export const maskEmail=email=>email.replace(/^(.{1,2}).*(@.*)$/,'$1***$2');
export function installVerifiedDeliveries(app,{pool,writer,runtime}){
 const macKey=runtime.required('credential_key','HUFU_CREDENTIAL_KEY');
 const endpoint=runtime.optional('email_otp_mail_url','HUFU_EMAIL_OTP_MAIL_URL');
 const gatewayToken=runtime.optional('email_otp_mail_token','HUFU_EMAIL_OTP_MAIL_TOKEN');
 const send=endpoint&&gatewayToken?otpMailGateway(endpoint,gatewayToken):null;
 const sql=async(token,name,b)=>{const proof=createHash('sha256').update(token).digest('hex');return(await pool.query('SELECT vault2.delivery_'+name+'($1,$2::jsonb) result',[proof,JSON.stringify(b)])).rows[0].result;};
 const scalar=async(token,name,arg)=>{const proof=createHash('sha256').update(token).digest('hex');return(await pool.query('SELECT vault2.delivery_'+name+'($1,$2::uuid) result',[proof,arg])).rows[0].result;};
 const token=req=>{const t=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];if(!t||t.length>4096)throw Object.assign(Error('unauthenticated'),{status:401});return t;};
 const noStore=reply=>reply.header('cache-control','no-store').header('pragma','no-cache').header('referrer-policy','no-referrer');
 const safe=handler=>async(req,reply)=>{noStore(reply);try{return await handler(req,reply);}catch(e){const failure=infrastructureFailure(e);const code=failure?.code??(e.code==='23505'?'idempotency_conflict':e.code==='40001'?'revision_conflict':e.code==='22023'?'invalid_input':e.status?e.message:'delivery_dependency_unavailable');reply.code(e.status??failure?.status??(['idempotency_conflict','revision_conflict'].includes(code)?409:code==='invalid_input'?400:503));return{state:'failed',error_code:code};}};
 const invalid=()=>{throw Object.assign(Error('invalid_input'),{status:400});};
 const input=(req,allowed)=>{const b=req.body??{};if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!allowed.includes(k)))invalid();return b;};
 app.get('/v2/vault/deliveries/help',{logLevel:'silent'},async(_req,reply)=>{
  noStore(reply);return {system:'hufu',mcp_tool:'hub2_api',base:'/v2/vault/deliveries',identity:'Bearer current member/client; actor never supplied in body',workflow:['apply','applications','register_for_application_if_needed','decide','list','challenge','verify','authenticated_download'],verification:{apply_and_status:'current_MCP_identity;no_extra_OTP',sensitive_file_download:'verified_member_email_OTP',approval:'current_supervisor_with_authorized_management_credential;no_browser_requirement'},operations:{close:{method:'POST',fields:['item_id','reason?'],effect:'stop_future_claims_preserve_delivered_history'},apply:{method:'POST',fields:['title','purpose?','requested_expires_at?','idempotency_key']},applications:{method:'POST',fields:['view:mine|pending|reviewed','limit?','cursor?']},candidates:{method:'POST',fields:['application_id']},register:{method:'POST',fields:['title','recipient_id','filename','content_base64','expires_at','scope?','application_id?','idempotency_key']},decide:{method:'POST',fields:['application_id','expected_revision','decision:approve|reject','item_id:required_for_approve','expires_at?','reason?']},list:{method:'POST',fields:[]},challenge:{method:'POST',fields:['item_id']},verify:{method:'POST',fields:['challenge_id','code']},download:{method:'GET',path:'/download/<delivery_id>',format:'browser:binary_attachment;MCP:JSON_base64_envelope',json_transport:{request_headers:{Accept:'application/json'},compatibility:'existing_MCP_Content-Type_application/json',response_fields:['state','encoding','filename','size','sha256','bytes_base64','receipt_id']},same_authorization:true,save_to_private_local_file:true}},approval_scope:'Authorizes retrieval of an applicant-bound pre-provisioned credential;does_not_mint_server/project_privileges',management_confirmation:{challenge:'/v2/engineering/management/challenge',verify:'/v2/engineering/management/verify',scope:'Reuse a live confirmation for the same principal/software/credential. Approval requires the original capability ceiling or a server-recorded temporary hufu.vault.decide context created by the same real supervisor OTP. Original client actions remain unchanged; original project/resource filters and current management source still apply. Project-filtered confirmation cannot authorize global personal deliveries.'},manager_setup:'Use a genuine supervisor API/software credential with hufu.credential.manage, or an email-OTP-authenticated supervisor session;ordinary_work_tokens_are_not_silently_promoted'};
 });
 app.post('/v2/vault/deliveries/list',{logLevel:'silent'},safe(async req=>{
  input(req,[]);const t=token(req),proof=createHash('sha256').update(t).digest('hex');return(await pool.query('SELECT vault2.delivery_list($1) result',[proof])).rows[0].result;
 }));
 app.post('/v2/vault/deliveries/recipients',{logLevel:'silent'},safe(async req=>{
  input(req,[]);const t=token(req),proof=createHash('sha256').update(t).digest('hex');return(await pool.query('SELECT vault2.delivery_recipients($1) result',[proof])).rows[0].result;
 }));
 const applicationFields={apply:['title','purpose','requested_expires_at','idempotency_key'],applications:['view','limit','cursor'],candidates:['application_id'],decide:['application_id','expected_revision','decision','item_id','expires_at','reason']};
 for(const op of Object.keys(applicationFields))app.post('/v2/vault/deliveries/'+op,{logLevel:'silent'},safe(async req=>{
  const t=token(req),b=input(req,applicationFields[op]);
  for(const k of ['application_id','item_id','cursor'])if(b[k]!==undefined&&!uuid.test(b[k]))invalid();
  if(op==='apply'&&(typeof b.title!=='string'||!b.title.trim()||b.title.length>160||typeof b.idempotency_key!=='string'||!b.idempotency_key||b.idempotency_key.length>160))invalid();
  for(const k of ['requested_expires_at','expires_at'])if(b[k]!==undefined&&!Number.isFinite(Date.parse(b[k])))invalid();
  if(op==='decide'&&(!uuid.test(b.application_id??'')||!Number.isInteger(b.expected_revision)||b.expected_revision<1||!['approve','reject'].includes(b.decision)||b.decision==='approve'&&!uuid.test(b.item_id??'')))invalid();
  if(op==='candidates'&&!uuid.test(b.application_id??''))invalid();
  return sql(t,op,b);
 }));
 app.post('/v2/vault/deliveries/register',{logLevel:'silent'},safe(async req=>{
  const t=token(req),b=input(req,['title','recipient_id','filename','expires_at','scope','idempotency_key','content_base64','application_id']);
  if(!uuid.test(b.recipient_id??'')||typeof b.title!=='string'||!b.title||b.title.length>120||typeof b.filename!=='string'||!/^[-A-Za-z0-9_.]{1,100}$/.test(b.filename)||typeof b.idempotency_key!=='string'||!b.idempotency_key||b.idempotency_key.length>160||typeof b.content_base64!=='string'||b.content_base64.length>Math.ceil(MAX_BYTES/3)*4||!/^[A-Za-z0-9+/]*={0,2}$/.test(b.content_base64)||!Number.isFinite(Date.parse(b.expires_at)))invalid();
  if(b.application_id!==undefined&&!uuid.test(b.application_id))invalid();
  const bytes=Buffer.from(b.content_base64,'base64');if(!bytes.length||bytes.length>MAX_BYTES||bytes.toString('base64')!==b.content_base64)invalid();
  const {content_base64,...meta}=b;const prepared=await sql(t,'register_prepare',meta);
  if(prepared.state==='ready')return{state:'already_registered',item_id:prepared.item_id};
  if(prepared.state==='closed')return prepared;
  const ref=prepared.secret_ref;
  let snapshot;try{snapshot=await writer.readKV(ref);}catch(e){if(e.code!=='secret_not_found')throw e;}
  if(!snapshot){await writer.writeKV(ref,{content_base64,filename:b.filename,item_id:prepared.item_id});snapshot=await writer.readKV(ref);}
  if(snapshot.data.item_id!==prepared.item_id||snapshot.data.content_base64!==content_base64)throw Object.assign(Error('idempotency_conflict'),{status:409});
  return sql(t,'register_finish',{item_id:prepared.item_id,secret_version:snapshot.metadata.version});
 }));
 app.post('/v2/vault/deliveries/close',{logLevel:'silent'},safe(async req=>{
  const b=input(req,['item_id','reason']);if(!uuid.test(b.item_id??'')||b.reason!==undefined&&(typeof b.reason!=='string'||b.reason.length>2000))invalid();
  return sql(token(req),'close',b);
 }));
 app.post('/v2/vault/deliveries/challenge',{logLevel:'silent'},safe(async req=>{
  const t=token(req),b=input(req,['item_id']);if(!uuid.test(b.item_id??''))invalid();if(!send)throw Object.assign(Error('email_otp_delivery_unavailable'),{status:503});
  const id=randomUUID(),code=String(randomInt(0,1000000)).padStart(6,'0');
  const prepared=await sql(t,'prepare',{item_id:b.item_id,challenge_id:id,code_mac:codeMAC(macKey,id,code)});
  if(prepared.state==='failed')return prepared;
  try{await send({email:prepared.email,otp:code,type:'email-verification'});}catch{
   await sql(t,'send_finish',{challenge_id:id,result:'unknown'}).catch(()=>{});
   return{state:'send_unknown',challenge_id:id,expires_at:prepared.expires_at,next_step:'if_email_arrives_verify_same_challenge;otherwise_request_new_challenge_later'};
  }
  const result=await sql(t,'send_finish',{challenge_id:id,result:'sent'});return{...result,email_hint:maskEmail(prepared.email)};
 }));
 app.post('/v2/vault/deliveries/verify',{logLevel:'silent'},safe(async req=>{
  const t=token(req),b=input(req,['challenge_id','code']);if(!uuid.test(b.challenge_id??'')||typeof b.code!=='string'||!/^\d{6}$/.test(b.code))invalid();
  const r=await sql(t,'verify',{challenge_id:b.challenge_id,code_mac:codeMAC(macKey,b.challenge_id,b.code)});
  return r.state==='verified'?{...r,download_path:'/v2/vault/deliveries/download/'+r.delivery_id,authorization:'same_current_member_and_credential_required'}:r;
 }));
 app.get('/v2/vault/deliveries/download/:id',{logLevel:'silent'},safe(async(req,reply)=>{
  const t=token(req),id=req.params.id;if(!uuid.test(id??''))invalid();const p=await scalar(t,'download_prepare',id);
  const s=await writer.readKV({mount:'hub2',path:p.secret_ref.slice('bao:hub2/'.length),version:p.secret_version});
  if(!s.data.content_base64||s.data.filename!==p.filename||s.data.item_id!==p.item_id)throw Error('secret_binding_conflict');
  const bytes=Buffer.from(s.data.content_base64,'base64');if(!bytes.length||bytes.length>MAX_BYTES)throw Error('secret_payload_invalid');
  const result=await scalar(t,'download_consume',id);
  // MCP's existing public API transport sends Content-Type: application/json
  // for GET as well as POST. Preserve browser attachments and negotiate a
  // JSON envelope only after the identical authorization and consume path.
  const accept=String(req.headers.accept||'').split(',').map(x=>x.split(';')[0].trim());
  const jsonTransport=accept.includes('application/json')||
   String(req.headers['content-type']||'').split(';')[0].trim()==='application/json';
  if(jsonTransport)return reply.header('content-type','application/json').send({
   state:'downloaded',encoding:'base64',filename:p.filename,size:bytes.length,
   sha256:createHash('sha256').update(bytes).digest('hex'),
   bytes_base64:bytes.toString('base64'),receipt_id:result.receipt_id
  });
  return reply.header('content-type','application/octet-stream').header('content-disposition','attachment; filename="'+p.filename+'"').header('x-hufu-delivery-receipt',result.receipt_id).send(bytes);
 }));
}

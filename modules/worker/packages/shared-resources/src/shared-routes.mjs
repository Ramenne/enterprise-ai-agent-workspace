import {createHash,timingSafeEqual} from 'node:crypto';
const forbidden=()=>{const e=new Error('untrusted_shared_executor');e.statusCode=403;throw e};
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
/** Install inside current Hufu. No administrator/member token substitution.
 * SQL pool must be the existing hub2_hufu role. Executor private relays call
 * these two loopback routes; configuration must never be publicized by gateway. */
export function installSharedRoutes(app,pool,{serviceKey,executorUrl}){
 const url=new URL(executorUrl);
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/execute-shared'||url.username||url.password||url.search||url.hash)throw Error('protected_shared_executor_required');
 const trusted=req=>{if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.ip)||!same(req.headers['x-hub-service-key'],serviceKey))forbidden()};
 app.post('/internal/shared-resource/configuration',async req=>{
  trusted(req);const id=req.body?.usage_id;if(typeof id!=='string')forbidden();
  const result=await pool.query('select authz.shared_resource_configuration($1::uuid) as result',[id]);return result.rows[0].result;
 });
 app.post('/internal/shared-resource/check',async req=>{
  trusted(req);const token=req.headers.authorization;
  if(typeof token!=='string'||!token.startsWith('Bearer ')||!token.slice(7))forbidden();
  const hash=createHash('sha256').update(token.slice(7)).digest('hex');
  const result=await pool.query('select authz.shared_resource_check($1::text,$2::jsonb) as result',[hash,req.body]);return result.rows[0].result;
 });
 app.post('/v2/resources/shared/execute',{bodyLimit:3*1024*1024},async(req,reply)=>{
  const token=req.headers.authorization;if(typeof token!=='string'||!token.startsWith('Bearer '))forbidden();
  let response;try{response=await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{authorization:token,'content-type':'application/json','x-hub-resource-key':serviceKey},body:JSON.stringify(req.body)});}catch{return reply.code(503).send({state:'execution_unavailable',error_code:'shared_executor_unavailable'})}
  const bytes=await response.text();if(Buffer.byteLength(bytes)>3*1024*1024)return reply.code(502).send({state:'response_invalid'});
  return reply.code(response.status).send(JSON.parse(bytes));
 });
 // Manager endpoints record real actors via SQL. Save is pending; consumer
 // confirm is a second current manager call. Neither operation issues work rights.
 for(const [route,fn]of Object.entries({'dns-record-register':'shared_dns_record_register','dns-read-register':'shared_dns_read_register',binding:'shared_binding_create',save:'shared_usage_save',confirm:'shared_usage_confirm',revoke:'shared_usage_revoke',read:'shared_usage_read'})){
  app.post('/v2/resources/shared/usages/'+route,async req=>{
   const token=req.headers.authorization;if(typeof token!=='string'||!token.startsWith('Bearer ')||!token.slice(7))forbidden();
   const hash=createHash('sha256').update(token.slice(7)).digest('hex');
   const result=await pool.query('select authz.'+fn+'($1::text,$2::jsonb) as result',[hash,req.body]);return result.rows[0].result;
  });
 }
}

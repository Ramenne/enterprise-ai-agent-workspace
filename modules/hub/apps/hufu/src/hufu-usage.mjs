import{createHash}from'node:crypto';import{installUsage}from'../../../packages/platform/src/usage.js';
/** Existing request authentication only; no Actor or scope is read from body. */
export function installHufuUsage(app,{pool,usagePool,memberAuth,directory}){
 installUsage(app,pool,{pool:usagePool,directory,scopeHandles:async(request,observation)=>{
  let token=request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if(!token&&memberAuth&&request.headers.cookie){try{const h=new Headers();h.set('cookie',request.headers.cookie);token=(await memberAuth.auth.api.getSession({headers:h}))?.session?.token;}catch{}}
  if(!token)return[];
  try{const proof=createHash('sha256').update(token).digest('hex');const row=(await usagePool.query('SELECT authz.capture_hufu_usage($1,$2,$3) AS id',[proof,observation.request,observation.action])).rows[0];return row?.id?[row.id]:[];}catch{return[];}
 }});
}

import http from 'node:http';
import {S3Objects} from '../../platform/src/s3.js';
export const LEGACY_BUCKET='mengstore-1316920087';
export const LEGACY_ARCHIVE_PREFIX='hub2-archive/';
const isLegacy=locator=>locator?.provider==='cos-legacy-shanghai'&&locator.bucket===LEGACY_BUCKET;
/** Private machine capability. Current member authorization remains in Mem SQL. */
export function legacyScopeProvider({socketPath='/run/hub2-legacy-source770/reader.sock'}={}){
 return async(locator,operation,context={})=>{
  if(!isLegacy(locator))throw Object.assign(Error('legacy_scope_required'),{code:'legacy_scope_required'});
  const payload=JSON.stringify({locator,operation,...context});
  return new Promise((resolve,reject)=>{
   const req=http.request({socketPath,path:'/tier-session',method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(payload)},timeout:20000},response=>{
    let data='';response.on('data',chunk=>{data+=chunk.toString();if(Buffer.byteLength(data)>16384)response.destroy(Error('invalid_legacy_capability_response'));});
    response.on('error',()=>reject(Object.assign(Error('legacy_capability_unavailable'),{code:'legacy_capability_unavailable'})));
    response.on('end',()=>{try{const result=JSON.parse(data);if(response.statusCode!==200)throw Object.assign(Error(result.error_code??'legacy_capability_unavailable'),{code:result.error_code??'legacy_capability_unavailable'});resolve(result);}catch(e){const code=e.code??'legacy_capability_invalid_response';reject(Object.assign(Error(code),{code}));}});
   });req.on('timeout',()=>req.destroy(Error('legacy_capability_unavailable')));req.on('error',()=>reject(Object.assign(Error('legacy_capability_unavailable'),{code:'legacy_capability_unavailable'})));req.end(payload);
  });
 };
}
/** Original admitted keys keep their reader; new managed copies use their exact locator. */
export function withLegacyArchiveReads(adapter,{provider,DomainError,Objects=S3Objects}){
 return new Proxy(adapter,{get(target,key){
  if(key==='read')return async object=>{
   if(!isLegacy(object)||!object.key.startsWith(LEGACY_ARCHIVE_PREFIX))return target.read(object);
   const locator={provider:object.provider,bucket:object.bucket,key:object.key,version_id:object.versionId};
   const head=await provider.head(locator);
   if(['restore_required','restoring'].includes(head.state))throw new DomainError('restore_required',409,true);
   const {bag}=await provider.session(locator,'read');
   const store=new Objects({endpoint:'https://cos.ap-shanghai.myqcloud.com',region:'ap-shanghai',bucket:LEGACY_BUCKET,forcePathStyle:false,accessKeyId:bag.access_key_id,secretAccessKey:bag.secret_access_key,sessionToken:bag.session_token});
   let stream;try{stream=await store.read(object);}catch(e){store.close();throw e;}
   return(async function*(){try{for await(const chunk of stream)yield chunk;}finally{store.close();}})();
  };
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
}

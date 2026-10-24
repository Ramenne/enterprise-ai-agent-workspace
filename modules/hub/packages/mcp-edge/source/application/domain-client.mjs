import {randomUUID,createHash} from 'node:crypto';
const supplemental={
 'mem.material.locate':{service:'mem',method:'POST',path:'/v2/materials/locate',readOnly:true},
 'mem.object.warm':{service:'mem',method:'POST',path:'/v2/objects/storage-tier/warm',readOnly:false},
 'mem.object.archive':{service:'mem',method:'POST',path:'/v2/objects/storage-tier/archive',readOnly:false},
 'mem.object.storage_info':{service:'mem',method:'POST',path:'/v2/objects/storage-tier/info',readOnly:true}
};
/** Trusted application calls use the same registered route metadata as native MCP. */
export function createDomainInvoker({routes,request,fallback,endpoints={}}){
 for(const endpoint of Object.values(endpoints)){if(!endpoint)continue;const u=new URL(endpoint);if(!['http:','https:'].includes(u.protocol)||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw Error('protected_capability_endpoint_required');}
 return async(auth,name,args,req)=>{
  const route=routes[name]??supplemental[name];
  // Optional separately hosted capabilities retain their configured adapter.
  if(!route)return fallback(auth,name,args,req);
  const baseUrl=route.endpointKey?endpoints[route.endpointKey]:undefined;
  if(route.endpointKey&&!baseUrl)throw Object.assign(Error(route.endpointKey+'_unconfigured'),{status:503,retryable:false});
  const body={...args};let path=route.path;
  if(route.pathParameter){const value=body[route.pathParameter];if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))throw Object.assign(Error('invalid_path_parameter'),{status:400});path=path.replace(':'+route.pathParameter,value);delete body[route.pathParameter];}
  if(route.method==='POST'&&!route.readOnly&&body.idempotency_key===undefined)body.idempotency_key=randomUUID();
  const logicalKey=typeof body.idempotency_key==='string'?body.idempotency_key:undefined;
  const idempotencyHeaderKey=logicalKey===undefined?undefined:/^[\x20-\x7e]{1,200}$/.test(logicalKey)?logicalKey:'utf8-'+createHash('sha256').update(logicalKey).digest('hex');
  if(route.endpointKey==='semantic')delete body.idempotency_key;
  let result;try{result=await request(auth,{...route,path,idempotencyHeaderKey,...(baseUrl?{baseUrl}:{})},route.method==='POST'?body:undefined,req);}catch(e){if(!route.endpointKey||Number.isInteger(e.status))throw e;throw Object.assign(Error(route.endpointKey+'_dependency_unavailable'),{status:503,retryable:true});}
  if(route.endpointKey&&['capability_unavailable','failed','denied'].includes(result?.state))throw Object.assign(Error(result.error_code||route.endpointKey+'_dependency_unavailable'),{status:result.state==='denied'?403:503,retryable:result.retryable,detail:result});
  return result;
 };
}

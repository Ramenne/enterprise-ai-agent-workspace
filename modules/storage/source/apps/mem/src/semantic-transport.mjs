import{createHash}from'node:crypto';
const routes={'mem.semantic.query':'/semantic/description-query','mem.semantic.index_fixed':'/semantic/description-index'};
const unavailable=(error_code='semantic_dependency_unavailable',retryable=true,http_status=503)=>({state:'capability_unavailable',error_code,retryable,http_status});
async function boundedJson(response,max=1024*1024){const reader=response.body?.getReader();if(!reader)throw Error('empty_response');const chunks=[];let size=0;try{for(;;){const r=await reader.read();if(r.done)break;size+=r.value.byteLength;if(size>max)throw Error('response_limit');chunks.push(Buffer.from(r.value));}}catch(e){await reader.cancel().catch(()=>{});throw e;}const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||Array.isArray(value)||typeof value!=='object'||typeof value.state!=='string')throw Error('invalid_response');return value;}
/** Optional domain capability transport: current caller and source, no protocol broker. */
export function semanticBroker({url,fetcher=fetch,error=(code,status,retryable=false)=>Object.assign(Error(code),{code,status,retryable})}={}){
 let endpoint;if(url){endpoint=new URL(url);if(!['http:','https:'].includes(endpoint.protocol)||!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||endpoint.pathname!=='/')throw Error('protected_semantic_endpoint_required');}
 return async(token,source,input,tool='mem.semantic.query')=>{
  if(!Object.hasOwn(routes,tool))throw error('unsupported_semantic_operation',400);
  if(!endpoint)return unavailable('semantic_unconfigured',false);
  const body={...input,...(source?{source_context:source}:{})},key=body.idempotency_key;delete body.idempotency_key;
  const headerKey=typeof key==='string'?(/^[\x20-\x7e]{1,200}$/.test(key)?key:'utf8-'+createHash('sha256').update(key).digest('hex')):undefined;
  let response;try{response=await fetcher(new URL(routes[tool],endpoint),{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',accept:'application/json',...(headerKey?{'Idempotency-Key':headerKey}:{})},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(10000)});}catch{return unavailable();}
  if(response.status===401){await response.body?.cancel();throw error('unauthenticated',401);}
  if(response.status===403){await response.body?.cancel();return unavailable('semantic_forbidden',false,403);}
  if(response.status>=500||response.status===429){await response.body?.cancel();return unavailable('semantic_dependency_unavailable',true,response.status);}
  let result;try{result=await boundedJson(response);}catch{return unavailable();}
  if(!response.ok){const code=/^[a-z][a-z0-9_]{0,100}$/.test(result.error_code||'')?result.error_code:'semantic_request_rejected';return unavailable(code,false,response.status);}
  return result;
 };
}

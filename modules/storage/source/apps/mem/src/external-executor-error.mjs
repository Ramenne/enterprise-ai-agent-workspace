/** Read only bounded, structured diagnostics from the protected executor. */
export async function executorFailure(response){
 let text='',total=0;
 try{
  if(response.body?.getReader){
   const reader=response.body.getReader();
   try{for(;;){const{done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>4096){await reader.cancel();return{code:'external_executor_rejected'};}text+=new TextDecoder().decode(value);}}
   finally{reader.releaseLock();}
  }else{text=await response.text();if(Buffer.byteLength(text)>4096)return{code:'external_executor_rejected'};}
  const value=JSON.parse(text),code=value?.error_code;
  if(typeof code!=='string'||! /^[a-z][a-z0-9_]{0,99}$/.test(code)||/[a-f0-9]{32}/.test(code)||/^(sk_|hub2_|bearer_|password_|secret_)/.test(code))return{code:'external_executor_rejected'};
  return{code,...(typeof value.retryable==='boolean'?{retryable:value.retryable}:{}),...(typeof value.request_id==='string'&&/^[a-f0-9-]{36}$/i.test(value.request_id)?{request_id:value.request_id}:{})};
 }catch{return{code:'external_executor_rejected'};}
}

const fail=(code,status=503)=>{throw Object.assign(Error(code),{code,status});};
export async function boundedJSON(response,max=8*1024*1024){
 if(!response.body)fail('asr_response_empty',502);
 const parts=[];let size=0;
 try{for await(const part of response.body){size+=part.length;if(size>max)fail('asr_response_too_large',502);parts.push(part);}return JSON.parse(Buffer.concat(parts).toString('utf8'));}
 catch(e){if(e.code&&e.status)throw e;fail('asr_response_invalid',502);}
}

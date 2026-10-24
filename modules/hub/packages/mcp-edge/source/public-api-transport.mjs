// Separate the MCP transport idempotency key from strict service domain bodies.
export function publicApiTransport(path,body){
 if(!path.startsWith('/v2/services/')||!body||!Object.hasOwn(body,'idempotency_key'))return{body};
 const{idempotency_key,...domain}=body;
 if(typeof idempotency_key!=='string'||idempotency_key.length<1||idempotency_key.length>200)throw Object.assign(Error('invalid_idempotency_key'),{status:400});
 return{body:domain,idempotencyKey:idempotency_key};
}

import {randomBytes,createCipheriv,createDecipheriv,createHash} from 'node:crypto';
const fingerprint=(credential:string,body:unknown)=>createHash('sha256').update(JSON.stringify([credential,body&&typeof body==='object'?Object.fromEntries(Object.entries(body).filter(([name])=>name!=='known')):body])).digest('hex');
/** Short lived, bound traversal position. Durable sync uses the delivered feed. */
export function workspaceCursorCodec(){const key=randomBytes(32);return {
 seal(after:unknown,credential:string,body:unknown){const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce),data=Buffer.from(JSON.stringify({after,binding:fingerprint(credential,body),expires:Date.now()+1800000})),encrypted=Buffer.concat([cipher.update(data),cipher.final()]);return Buffer.concat([nonce,cipher.getAuthTag(),encrypted]).toString('base64url');},
 open(value:string,credential:string,body:unknown){try{const bytes=Buffer.from(value,'base64url');if(bytes.length<29||bytes.length>1024)throw Error();const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28));const data=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString());if(data.binding!==fingerprint(credential,body)||data.expires<=Date.now())throw Error();return data.after;}catch{throw Error('workspace_cursor_invalid_refresh');}}
};}

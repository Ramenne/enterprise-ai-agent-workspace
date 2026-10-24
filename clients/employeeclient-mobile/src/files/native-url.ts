import {serviceOrigin} from '@/api/runtime';
export function isNativeFileUrl(value:string){
 try{const u=new URL(value,window.location.href),origin=new URL(serviceOrigin()||window.location.origin,window.location.href).origin;
 return u.origin===origin&&(u.pathname==='/native/file'||/^\/business\/v1\/private-attachments\/[a-f0-9-]{36}\/file$/.test(u.pathname))&&!u.username&&!u.password;}catch{return false;}
}

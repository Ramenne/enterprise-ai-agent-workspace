import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';
import type {UploadFile} from '@/chat/files';
const prefix='qn.upload-resume:';
const read=(f:UploadFile,a:number,b:number)=>f.readPart?f.readPart(a,b):Promise.resolve(f.slice!(a,b));
export async function resumeIdentity(account:string,f:UploadFile,purpose:string){
 const first=await read(f,0,Math.min(65536,f.size)),last=await read(f,Math.max(0,f.size-65536),f.size);
 const h=sha256.create().update(new TextEncoder().encode(JSON.stringify([f.name,f.type,f.size,f.lastModified,purpose])));h.update(new Uint8Array(await first.arrayBuffer()));h.update(new Uint8Array(await last.arrayBuffer()));
 return prefix+JSON.stringify([account,bytesToHex(h.digest())]);
}
export async function fileDigest(f:UploadFile,check:()=>void,progress:(loaded:number)=>void=()=>{}){const h=sha256.create();for(let n=0;n<f.size;n+=524288){check();h.update(new Uint8Array(await(await read(f,n,Math.min(n+524288,f.size))).arrayBuffer()));progress(Math.min(n+524288,f.size));await new Promise(r=>setTimeout(r,0));}check();return bytesToHex(h.digest());}
export function rememberedUpload(identity:string,fallback:string){try{return localStorage.getItem(identity)||fallback;}catch{return fallback;}}
export function rememberUpload(identity:string,key:string){try{localStorage.setItem(identity,key);}catch{}}
export function clearUploadReceipts(account:string){for(const k of Object.keys(localStorage))if(k.startsWith(prefix))try{if(JSON.parse(k.slice(prefix.length))[0]===account)localStorage.removeItem(k);}catch{}}

import{readFile,stat}from'node:fs/promises';
import{createHash}from'node:crypto';
const files=new Map();
export async function cachedFile(path){
 const stamp=await stat(path,{bigint:true}),key=[stamp.mtimeNs,stamp.ctimeNs,stamp.size].join(':');
 const old=files.get(String(path));if(old?.key===key)return old;
 const bytes=await readFile(path),value={key,bytes,text:bytes.toString('utf8'),etag:'"'+createHash('sha256').update(bytes).digest('hex')+'"'};
 files.set(String(path),value);if(files.size>100)files.delete(files.keys().next().value);return value;
}
export function conditional(req,res,value,{type='application/json; charset=utf-8',cache='private, max-age=0, must-revalidate',vary='Cookie, Authorization'}={}){
 const body=Buffer.isBuffer(value)?value:typeof value==='string'?Buffer.from(value):Buffer.from(JSON.stringify(value));
 const etag='"'+createHash('sha256').update(body).digest('hex')+'"';
 const headers={'cache-control':cache,etag,vary,'content-type':type,'x-content-type-options':'nosniff'};
 if((req.headers['if-none-match']||'').split(',').map(s=>s.trim().replace(/^W\//,'')).includes(etag)){res.writeHead(304,headers);res.end();return;}
 res.writeHead(200,headers);res.end(body);
}

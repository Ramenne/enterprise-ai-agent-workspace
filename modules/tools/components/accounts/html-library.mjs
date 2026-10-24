import {createCloudLibrary} from './html-cloud.mjs';
import {createHtmlIndexStore} from './html-index.mjs';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {isAdmin} from './access-control.mjs';

// The public HTML library stores content in Dream storage. Historical local
// tables are archived separately and must never be recreated on app startup.
export function createHtmlLibrary(db){
 return {directoryCache:createHtmlIndexStore(db)};
}

const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value))};
async function readBody(req){
 const buffers=[];let bytes=0;
 for await(const chunk of req){bytes+=chunk.length;if(bytes>3*1024*1024)throw fail(413,'上传内容过大，单个 HTML 文件最大 2 MB');buffers.push(chunk)}
 try{return JSON.parse(Buffer.concat(buffers).toString('utf8'))}catch{throw fail(400,'请求格式无效')}
}
export function htmlLibraryHandler(library,{cloud=createCloudLibrary({cache:library.directoryCache}),webRoot=process.env.HTML_LIBRARY_WEB||fileURLToPath(new URL('./html-library-web/',import.meta.url))}={}){
 return async(req,res,url,member)=>{
  const path=url.pathname;
  try{
   if(['/html/api/cloud/projects','/html/api/cloud/upload','/html/api/cloud/start','/html/api/cloud/status'].includes(path)&&!isAdmin(member.owner))return json(res,403,{error:'仅管理员可以管理统一 HTML 图书馆'});
   if(path==='/html/api/cloud/index'&&req.method==='GET')return json(res,200,await cloud.directory(member));
   if(path==='/html/api/cloud/projects'&&req.method==='GET')return json(res,200,await cloud.projects(member));
   if(path==='/html/api/cloud/upload'&&req.method==='POST'){const result=await cloud.upload(member,await readBody(req));return json(res,result.state==='published'?201:202,result)}
   // Historical local data is preserved offline; the public tool only uses Dream storage.
   if(path.startsWith('/html/api/items')||path.startsWith('/html/file/'))return json(res,410,{error:'独立工具文件库已停用，请使用资料存储服务'});
   if(path==='/html/api/cloud/start'&&req.method==='POST')return json(res,202,cloud.start(member,{force:(await readBody(req)).force===true}));
   if(path==='/html/api/cloud/status'&&req.method==='GET')return json(res,200,cloud.status(member,url.searchParams.get('job')));
   const cloudFile=path.match(/^\/html\/cloud\/file\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/);
   if(cloudFile&&['GET','HEAD'].includes(req.method)){const row=await cloud.file(member,cloudFile[1],cloudFile[2]);return serveHtml(res,req,url,row.filename,row.bytes)}
   if(path==='/html'){res.writeHead(303,{Location:'/html/'});return res.end()}
   if(!['GET','HEAD'].includes(req.method))return json(res,405,{error:'方法不支持'});
   const assets={'/html/':'index.html','/html/assets/library.css':'library.css','/html/assets/library.js':'library.js'};
   if(!assets[path])return json(res,404,{error:'页面不存在'});
   const bytes=await readFile(resolve(webRoot,assets[path]));
   const type=path.endsWith('.css')?'text/css':path.endsWith('.js')?'text/javascript':'text/html';
   res.writeHead(200,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:bytes);
  }catch(error){const message=error.status?error.message:'HTML 管理库暂时不可用，请稍后重试';if(path.startsWith('/html/cloud/file/'))return serveError(res,error.status||500,message);return json(res,error.status||500,{error:message})}
 };
}

function serveHtml(res,req,url,filename,bytes){
 res.setHeader('X-Frame-Options','SAMEORIGIN');
 res.setHeader('Referrer-Policy','no-referrer');
 res.setHeader('Content-Security-Policy',"sandbox allow-scripts allow-downloads; default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; connect-src 'none'; frame-src 'none'; object-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
 res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
 const download=url.searchParams.get('download')==='1';
 res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Disposition':`${download?'attachment':'inline'}; filename="document.html"; filename*=UTF-8''${encodeURIComponent(filename)}`});
 return res.end(req.method==='HEAD'?undefined:bytes);
}

function serveError(res,status,message){
 const safe=String(message).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 res.setHeader('X-Frame-Options','SAMEORIGIN');res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'");
 res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
 res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>资料暂时无法打开</title><style>body{font:14px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;padding:40px;color:#414145;background:#fafafa}h1{font-size:20px}p{line-height:1.9;color:#85858a}</style><h1>资料暂时无法打开</h1><p>'+safe+'</p><p>关闭预览，刷新资料存储服务后重试。</p></html>');
}

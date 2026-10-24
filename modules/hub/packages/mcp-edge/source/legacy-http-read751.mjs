import {readFileSync} from 'node:fs';
import {once} from 'node:events';
/** Route only explicitly selected migrated files. Metadata is not authority:
 * both fixed/latest helpers authenticate the caller and apply current rights. */
export function createLegacyHttpRead({readLatest,readFixed,error,selectedIds,streamFile,isSelected}) {
 let extra=[];
 try{
  const config=JSON.parse(readFileSync(new URL('./legacy-http-selection754.json',import.meta.url),'utf8'));
  if(!Array.isArray(config.selected_file_ids)||config.selected_file_ids.length>1000||config.selected_file_ids.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(id)))throw Error('invalid_http_selection');
  extra=config.selected_file_ids;
 }catch(e){if(e.code!=='ENOENT')throw e;}
 const selected=new Set([...selectedIds,...extra]);
 return async function legacyHttpRead(req,res){
  const url=new URL(req.url,'http://127.0.0.1');
  const match=/^\/legacy-files\/([A-Za-z0-9_-]{1,100})(?:\/([1-9]\d*))?$/.exec(url.pathname);
  if(!match)return false;
  if(req.method!=='GET')throw error('GET_required',405);
  const id=match[1];if(!selected.has(id)&&!await isSelected?.(id))throw error('not_registered',404);
  if([...url.searchParams.keys()].some(k=>!['ver','v'].includes(k))||url.searchParams.has('ver')&&url.searchParams.has('v')||match[2]&&(url.searchParams.has('ver')||url.searchParams.has('v')))throw error('invalid_version_selection',400);
  const token=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if(!token||token.length>4096)throw error('member_authorization_required',401);
  const raw=match[2]??url.searchParams.get('ver')??url.searchParams.get('v');
  const args={file_id:id};
  if(raw!==null){if(!/^[1-9]\d*$/.test(raw)||!Number.isSafeInteger(Number(raw)))throw error('invalid_version_selection',400);args.ver=Number(raw);}
  const caller={token,req,message_id:'legacy-http-'+id};
  const response=raw===null?await readLatest(caller,args):await readFixed(caller,args);
  if(!response?.handled)throw error('mapped_reference_unavailable',409);
  if(response.result?.state==='historical_metadata_unverified'){res.writeHead(409,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(response.result));return true;}
  const result=response.result;
  if(result.state==='metadata_only'&&streamFile){
   const upstream=await streamFile(caller,args);
   res.writeHead(200,{'content-type':upstream.headers.get('content-type')??'application/octet-stream','cache-control':'private, no-store','x-content-type-options':'nosniff',...(upstream.headers.get('content-length')?{'content-length':upstream.headers.get('content-length')}:{})});
   for await(const bytes of upstream.body){if(res.destroyed)break;if(!res.write(bytes))await once(res,'drain');}
   if(!res.destroyed)res.end();return true;
  }
  const bytes=typeof result.text==='string'?Buffer.from(result.text,'utf8'):
   typeof result.bytes_base64==='string'?Buffer.from(result.bytes_base64,'base64'):null;
  if(!bytes||bytes.length!==result.size)throw error('mapped_body_unavailable',502);
  const ref=result.source_version??{};
  res.writeHead(200,{'content-type':result.content_type??'application/octet-stream',
   'content-length':bytes.length,'cache-control':'private, no-store',
   'x-content-type-options':'nosniff',
   ...(ref.version_id?{'x-hub2-version-id':ref.version_id}:{})});
  res.end(bytes);return true;
 };
}

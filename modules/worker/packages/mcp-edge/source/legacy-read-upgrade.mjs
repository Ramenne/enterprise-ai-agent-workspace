import{createHash}from'node:crypto';
import{readFile}from'node:fs/promises';
const catalog=JSON.parse(await readFile(new URL('./catalog.json',import.meta.url),'utf8'));
const files=new Map(catalog.files.map(f=>[f.file_id,f]));

export class LegacyReadUpgradeError extends Error{
 constructor(code,status=503){super(code);this.code=code;this.status=status;this.handled=true;this.allow_old_fallback=false;}
}
/** Bind this returned readMigratedLegacy(caller,args) into the same-name old tool.
 * nextIdentity must authenticate/map the *actual caller*, never a Root proxy.
 * memberMem and readFull receive that current member identity for every request. */
export function createLegacyReadUpgrade(deps){
 return async function readMigratedLegacy(caller,args){return readMigratedLegacyImpl(caller,args,deps);};
}
export async function readMigratedLegacy(caller,args,deps){
 return readMigratedLegacyImpl(caller,args,deps);
}
async function readMigratedLegacyImpl(caller,args,{locateFile,memberMem,readFull,nextIdentity}){
 const file=files.get(args?.file_id),ver=args?.ver;
 // Omitted/latest/string/zero are not upgraded. Old writer remains latest authority.
 if(!file||!Number.isSafeInteger(ver)||ver<=0)return{handled:false};
 const original=file.versions.find(v=>v.ver===ver);if(!original)return{handled:false};
 try{
  const location=await locateFile(args.file_id,caller);
  if(!location||location.source_system!==catalog.source_system||location.project_id!==catalog.project_id)return{handled:false};
  const identity=await nextIdentity(caller);
  if(!identity?.actor_id)throw new LegacyReadUpgradeError('current_member_required',401);
  const lookup=await memberMem(identity,'/v2/legacy/references/lookup',{project_id:location.project_id,source_system:catalog.source_system,
   source_id:args.file_id,field_path:'version:'+ver,actor_namespace:false});
  if(lookup?.state==='not_bound'&&!lookup.error_code)return{handled:false};
  if(!lookup?.binding_id)throw new LegacyReadUpgradeError(lookup?.error_code??'mapped_lookup_unavailable',lookup?.error_code==='forbidden'?403:503);
  // From here a binding exists. Denial/bad source/cold restore-required never
  // falls back to old storage to bypass current rights or physical state.
  const resolved=await memberMem(identity,'/v2/legacy/references/resolve',{project_id:location.project_id,binding_id:lookup.binding_id});
  if(resolved?.state!=='available'||resolved.reference_kind!=='fixed'||!resolved.fixed_ref)throw new LegacyReadUpgradeError('mapped_fixed_version_unavailable');
  const ref=resolved.fixed_ref;
  if(ref.size!==original.size||/^[a-f0-9]{64}$/.test(original.sha256)&&ref.sha256!==original.sha256)throw new LegacyReadUpgradeError('legacy_fixed_identity_mismatch',502);
  const response=await readFull(identity,{project_id:location.project_id,material_id:ref.material_id,version_id:ref.version_id});
  const raw=response?.bytes??response?.body??response;
  const stream=Buffer.isBuffer(raw)||raw instanceof Uint8Array?[raw]:raw;
  if(!stream?.[Symbol.asyncIterator]&&!stream?.[Symbol.iterator])throw new LegacyReadUpgradeError('mapped_body_unavailable');
  const chunks=[],hash=createHash('sha256');let size=0;
  for await(const b of stream){if(!(b instanceof Uint8Array))throw new LegacyReadUpgradeError('mapped_body_invalid',502);
   size+=b.byteLength;if(size>ref.size)throw new LegacyReadUpgradeError('mapped_body_integrity_mismatch',502);hash.update(b);chunks.push(Buffer.from(b));}
  if(size!==ref.size||hash.digest('hex')!==ref.sha256)throw new LegacyReadUpgradeError('mapped_body_integrity_mismatch',502);
  const bytes=Buffer.concat(chunks),text=bytes.toString('utf8');
  const textPath=/\.(?:md|txt|html?|json|csv|tsv|css|js|mjs|ts|ya?ml|xml|svg|sql|log)$/i.test(file.original_path);
  const isText=textPath&&Buffer.from(text,'utf8').equals(bytes);
  return{handled:true,result:{file_id:args.file_id,content_type:response?.content_type??(isText?'text/plain; charset=utf-8':'application/octet-stream'),size,
   // Use the actual stored old address; don't invent /f/id/n as canonical old URL.
   address:resolved.original_address,...(isText?{text}:{bytes_base64:bytes.toString('base64')}),
   source_version:{source_system:catalog.source_system,legacy_ver:ver,provider:'jiaxin_fixed_ref',
    project_id:location.project_id,material_id:ref.material_id,version_id:ref.version_id,sha256:ref.sha256}}};
 }catch(e){
  if(e instanceof LegacyReadUpgradeError)throw e;
  const safe=typeof e?.code==='string'&&/^[a-z][a-z0-9_]{0,100}$/.test(e.code)?e.code:'mapped_read_failed';
  throw new LegacyReadUpgradeError(safe,e.status??503);
 }
}

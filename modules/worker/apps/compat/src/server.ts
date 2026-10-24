import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {z} from 'zod';
import {server,bearer,DomainError} from '../../../packages/platform/src/http.js';

const fixed=z.object({version_id:z.uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/),size:z.number().int().nonnegative(),binding_id:z.uuid().optional()}).strict();
const mapping=z.object({legacy_id:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),project_id:z.uuid(),material_id:z.uuid(),
 latest_binding_id:z.uuid().optional(),unfinished_versions:z.array(z.number().int().nonnegative()).optional(),content_type:z.string().regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/).optional(),fixed_versions:z.record(z.string().regex(/^[1-9][0-9]*$/),fixed),coverage:z.enum(['partial','complete']),basis_sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const mappingManifest=z.object({contract:z.enum(['hub2-legacy-map-v1','hub2-legacy-map-v2']),maps:z.array(mapping).max(100000)}).strict();
export type MappingManifest=z.infer<typeof mappingManifest>;
type Fetch=typeof fetch;
export interface CompatConfig {memUrl:string;manifest:MappingManifest;fetch?:Fetch;}

/** Exact old references are an operator-reviewed map, never a grant or fuzzy match. */
export function createCompatServer(config:CompatConfig){
 const app=server('compat'),base=new URL(config.memUrl),request=config.fetch??fetch;
 if(base.protocol!=='https:'&&!(base.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(base.hostname)))throw new Error('protected_mem_endpoint_required');
 if(base.username||base.password||base.search||base.hash)throw new Error('invalid_mem_endpoint');
 const manifest=mappingManifest.parse(config.manifest),maps=new Map(manifest.maps.map(x=>[x.legacy_id,x]));
 if(manifest.contract==='hub2-legacy-map-v2'&&manifest.maps.some(m=>Object.values(m.fixed_versions).some(f=>!f.binding_id)))throw new Error('authoritative_legacy_bindings_required');
 if(maps.size!==manifest.maps.length)throw new Error('ambiguous_legacy_identity');
 async function post(path:string,token:string,body:Record<string,unknown>,source?:string){
  let response:Response;
  try{response=await request(new URL(path,base),{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+token,'content-type':'application/json',...(source?{'x-hub-source-context':source}:{})},body:JSON.stringify(body)});}catch{throw new DomainError('mem_unavailable',503,true);}
  if(!response.ok){await response.body?.cancel();throw new DomainError(response.status===401?'unauthenticated':[403,404].includes(response.status)?'not_found':'mem_request_failed',[403,404].includes(response.status)?404:response.status,response.status===503);}
  const chunks:Uint8Array[]=[];let size=0;
  if(!response.body)throw new DomainError('invalid_mem_response',502);
  for await(const chunk of response.body){size+=chunk.byteLength;if(size>1024*1024){await response.body.cancel().catch(()=>{});throw new DomainError('mem_response_too_large',502);}chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string,unknown>;}catch{throw new DomainError('invalid_mem_response',502);}
 }
 app.get('/ready',async()=>({service:'compat',state:'configured',coverage:'reviewed_mapping_loaded;upstream_authority_checked_per_operation',mapped_files:maps.size}));
 for(const route of ['/f/:id','/f/:id/raw','/f/:id/history'])app.get(route,async(req,reply)=>{
  const token=bearer(req),id=String((req.params as {id:string}).id),entry=maps.get(id);
  if(!entry)throw new DomainError('not_found',404);
  const currentPost=(path:string,body:Record<string,unknown>)=>post(path,token,body,typeof req.headers['x-hub-source-context']==='string'?req.headers['x-hub-source-context']:undefined);
  const query=req.query as Record<string,unknown>;
  if(Object.keys(query).some(x=>x!=='v')||(query['v']!==undefined&&(typeof query['v']!=='string'||!/^[0-9]+$/.test(query['v']))))throw new DomainError('invalid_legacy_version',400);
  if(query['v']===undefined&&manifest.contract==='hub2-legacy-map-v2'&&!entry.latest_binding_id)throw new DomainError('legacy_latest_binding_unmapped',404);
  if(query['v']!==undefined&&entry.unfinished_versions?.includes(Number(query['v'])))throw new DomainError('legacy_upload_unfinished',409);
  const scope={project_id:entry.project_id,material_id:entry.material_id};
  let ref:z.infer<typeof fixed>;
  if(query['v']!==undefined){const found=entry.fixed_versions[query['v']];if(!found)throw new DomainError('not_found',404);ref=found;}
  else{const head=await currentPost('/v2/materials/head',scope);if(head['state']!=='available')throw new DomainError('not_found',404);
   const hf=head['fixed_ref'] as Record<string,unknown>|undefined;const parsed=fixed.safeParse(hf?{version_id:hf['version_id'],sha256:hf['sha256'],size:hf['size']}:null);
   if(!parsed.success)throw new DomainError('invalid_mem_response',502);ref=parsed.data;
  }
  const binding=query['v']===undefined?entry.latest_binding_id:ref.binding_id;if(binding){const resolved=await currentPost('/v2/legacy/references/resolve',{project_id:entry.project_id,binding_id:binding});const f=resolved['fixed_ref'] as Record<string,unknown>|undefined;if(resolved['reference_kind']!==(query['v']===undefined?'latest':'fixed')||f?.['material_id']!==entry.material_id||f['version_id']!==ref.version_id||f['sha256']!==ref.sha256||f['size']!==ref.size)throw new DomainError('legacy_authoritative_mapping_changed',409);}
  let start=0,end=ref.size-1;if(req.headers.range){const r=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);if(!r)throw new DomainError('invalid_range',416);start=Number(r[1]);end=r[2]?Number(r[2]):end;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||end>=ref.size)throw new DomainError('invalid_range',416);}
  if(route.endsWith('/history')){const authorized=[];for(const[n,f]of Object.entries(entry.fixed_versions)){if(f.binding_id){await currentPost('/v2/legacy/references/resolve',{project_id:entry.project_id,binding_id:f.binding_id});}await currentPost('/v2/files/read-chunk',{...scope,version_id:f.version_id,offset:0,limit:1,encoding:'base64'});authorized.push({legacy_version:Number(n),fixed_ref:f});}return{versions:authorized,unfinished_versions:entry.unfinished_versions??[],coverage:entry.coverage,unknown_history_not_inferred:true};}
  const read=async(offset:number)=>{
   const result=await currentPost('/v2/files/read-chunk',{...scope,version_id:ref.version_id,offset,limit:Math.max(1,Math.min(65536,end-offset+1)),encoding:'base64'});
   const bytes=typeof result['bytes_base64']==='string'?Buffer.from(result['bytes_base64'],'base64'):null;
   const actual=result['fixed_ref'] as Record<string,unknown>|undefined,range=result['range'] as Record<string,unknown>|undefined;
   if(!bytes||actual?.['material_id']!==entry.material_id||actual['version_id']!==ref.version_id||actual['sha256']!==ref.sha256||actual['size']!==ref.size||range?.['start']!==offset||range['end_exclusive']!==offset+bytes.length||offset+bytes.length>Math.max(0,end+1)||(!bytes.length&&offset<ref.size)||createHash('sha256').update(bytes).digest('hex')!==result['chunk_sha256'])throw new DomainError('fixed_integrity_mismatch',502);
   return bytes;
  };
  // Authenticate and verify the first chunk before response headers; subsequent
  // chunks obtain fresh authority. No public provider URL or stored master key.
  const first=await read(start);
  async function* bytes(){
   const hash=createHash('sha256');let offset=start,chunk=first;
   do{if(req.raw.destroyed)return;hash.update(chunk);offset+=chunk.length;yield chunk;if(offset===Math.max(0,end+1))break;chunk=await read(offset);}while(offset<end+1);
   if(offset!==Math.max(0,end+1)||start===0&&end===ref.size-1&&hash.digest('hex')!==ref.sha256)throw new DomainError('fixed_integrity_mismatch',502);
  }
  if(req.headers.range)reply.code(206).header('content-range',`bytes ${start}-${end}/${ref.size}`);
  reply.header('accept-ranges','bytes').header('content-length',Math.max(0,end-start+1));if(route.endsWith('/raw'))reply.header('content-security-policy',"sandbox; default-src 'none'");
  reply.header('content-type',route.endsWith('/raw')?entry.content_type??'application/octet-stream':'application/octet-stream').header('content-disposition',route.endsWith('/raw')?'inline':'attachment').header('cache-control','private, no-store')
   .header('x-hub-fixed-version',ref.version_id).header('x-hub-content-sha256',ref.sha256)
   .header('x-hub-reference-mode',query['v']===undefined?'latest_at_request':'fixed_legacy_version');
  return reply.send(Readable.from(bytes()));
 });
 return app;
}

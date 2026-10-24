import {createHash,randomUUID} from 'node:crypto';
const hash=x=>createHash('sha256').update(x).digest('hex');
export const fullReadTool={name:'mem.read_full',description:'Read a currently authorized fixed document completely, automatically assembling byte ranges and checking whole SHA256. No manual chunk loop for normal documents. Provide project_id,material_id and optionally fixed version_id/sha256.',inputSchema:{type:'object',properties:{project_id:{type:'string'},material_id:{type:'string'},version_id:{type:'string'},sha256:{type:'string'},encoding:{enum:['utf8','base64']}},required:['material_id']}};
/** The original is read through current Mem authority; transport does not own content. */
export function createOriginalReader({mem,error}){
 return async(auth,args,{eventKey}={})=>{
  const material_id=args.material_id;if(!material_id)throw error('material_id_required',400);
  const located=await mem(auth,'/v2/materials/locate',{material_id,...(args.version_id?{version_id:args.version_id}:{})});
  const project_id=located.project_id;let fixed=located.fixed_ref;
  if(args.sha256&&args.sha256!==fixed?.sha256)throw error('fixed_reference_changed',409);
  if(!fixed)throw error('no_published_original',409);
  const budget=args.encoding==='base64'?4*1024*1024:512*1024;
  if(Number.isSafeInteger(Number(fixed.size))&&Number(fixed.size)>budget)throw Object.assign(error('whole_document_transport_budget',413),{detail:{fixed_ref:{...fixed,project_id},limit:budget,provider_send_count:0,next_step:'use_controlled_stage_or_stream_for_large_original;no_partial_body_returned'}});
  let offset=0,length=0;const bytes=[];
  do{
   const last=await mem(auth,'/v2/files/read-chunk',{project_id,material_id,version_id:fixed.version_id,offset,limit:65536,encoding:'base64'});
   if(!fixed.sha256)fixed=last.fixed_ref;
   const b=Buffer.from(last.bytes_base64,'base64');
   if(hash(b)!==last.chunk_sha256||last.fixed_ref.sha256!==fixed.sha256||last.fixed_ref.material_id!==material_id||last.fixed_ref.version_id!==fixed.version_id)throw error('fixed_integrity_failed',503);
   if(last.range?.start!==offset||last.range?.end_exclusive!==offset+b.length||last.next_offset!==null&&last.next_offset!==undefined&&(last.next_offset!==offset+b.length||b.length===0))throw error('fixed_range_invalid',503);
   length+=b.length;if(length>budget)throw Object.assign(error('whole_document_transport_budget',413),{detail:{fixed_ref:fixed,limit:budget,next_step:'use_mem.version.read_for_large_original;no_partial_body_returned'}});
   bytes.push(b);offset=last.next_offset;
  }while(offset!==null&&offset!==undefined);
  const data=Buffer.concat(bytes);if(hash(data)!==fixed.sha256)throw error('whole_original_integrity_failed',503);
  let useObservation;try{useObservation=await mem(auth,'/v2/materials/use',{project_id,material_id,version_id:fixed.version_id,kind:'body_read',event_key:eventKey||randomUUID()});}catch(e){useObservation={state:'pending',error_code:e.message,original_readability_unchanged:true};}
  let text;try{if(args.encoding!=='base64')text=new TextDecoder('utf-8',{fatal:true}).decode(data);}catch{}
  return{state:'read',fixed_ref:{...fixed,project_id},coverage:'whole_original',whole_fixed_integrity:'verified',size:data.length,use_observation:useObservation,...(text===undefined?{bytes_base64:data.toString('base64')}:{text}),understanding:'Agent_judgment'};
 };
}

import {attributeLabel,valueLabel} from './attribute-query.mjs';
// Preserve typed/nested metadata while presenting readable labels rather than JSON.
export function detailProperties(value,prefix=''){
 const rows=[];
 for(const [key,part] of Object.entries(value||{})){
  const path=prefix?prefix+'.'+key:key;
  if(part&&typeof part==='object'&&!Array.isArray(part))rows.push(...detailProperties(part,path));
  else if(Array.isArray(part)){
   const simple=part.filter(v=>v===null||typeof v!=='object');
   if(simple.length)rows.push({key:path,label:attributeLabel(path),value:simple.map(v=>valueLabel(v,key)).join('、')});
   part.filter(v=>v&&typeof v==='object').forEach((v,i)=>rows.push(...detailProperties(v,path+'.'+(i+1))));
  }else if(part!==undefined)rows.push({key:path,label:attributeLabel(path),value:valueLabel(part,key)});
 }
 return rows;
}
export function basisText(basis){
 if(typeof basis==='string')return basis;
 if(!basis||typeof basis!=='object')return '';
 return basis.explanation||basis.reason||basis.summary||detailProperties(basis).map(r=>r.label+'：'+r.value).join('\n');
}
export function fixedReference(input){
 const r=input?.fixed_ref||input?.reference||input;
 if(!r?.material_id)return null;
 return {...input,...r};
}
export function workRelations(value,currentId){
 const list=Array.isArray(value?.relations)?value.relations:[];
 const ledger=value?.work_item?.properties?.relations||value?.properties?.relations;
 const rows=[...list];
 for(const [kind,direction] of [['outgoing','cites'],['incoming','cited_by']])for(const r of ledger?.[kind]||[])for(const c of r.citations||[r]){
  const target=r.work_item_id||r.target_work_id;
  if(target)rows.push({...c,id:c.relation_id||c.id,from_work_id:direction==='cites'?currentId:target,to_work_id:direction==='cites'?target:currentId});
 }
 const seen=new Set();return rows.filter(r=>r.state!=='replaced'&&r.state!=='deleted').map(r=>{
  const outgoing=r.from_work_id===currentId,target=outgoing?r.to_work_id:r.from_work_id;
  return {...r,target,outgoing,targetProject:(outgoing?r.to_project_id:r.from_project_id)||value?.work_item?.project_id,short_no:outgoing?r.to_short_no:r.from_short_no,explanation:basisText(r.basis||r.reason)};
 }).filter(r=>{const key=r.id||r.from_work_id+':'+r.to_work_id;if(!r.target||seen.has(key))return false;seen.add(key);return true;});
}
export function sizeLabel(size){if(!Number.isFinite(size)||size<0)return '未知';if(size<1024)return size+' B';if(size<1024**2)return (size/1024).toFixed(1)+' KB';if(size<1024**3)return (size/1024**2).toFixed(1)+' MB';return (size/1024**3).toFixed(1)+' GB';}
export async function resolveFixedVersion(client,projectId,materialId,versionId,hash,signal){
 if(!/^[a-f0-9-]{36}$/i.test(versionId)||hash&&!/^[a-f0-9]{64}$/i.test(hash))throw Error('固定版本地址无效');
 let cursor;const seen=new Set();
 do{
  signal?.throwIfAborted();const page=await client.rpc('mem.material.history',{project_id:projectId,material_id:materialId,limit:100,...(cursor?{cursor}:{})},undefined,signal);
  const found=(page.items||[]).find(r=>r.material_id===materialId&&r.version_id===versionId);
  if(found){if(hash&&found.sha256!==hash||!Number.isSafeInteger(found.size)||found.size<0||!/^[a-f0-9]{64}$/i.test(found.sha256||''))throw Error('固定版本信息不一致，已停止读取');return found;}
  cursor=page.next_cursor||undefined;if(cursor&&seen.has(cursor))throw Error('文件版本分页未推进');if(cursor)seen.add(cursor);
 }while(cursor);
 throw Error('该固定版本当前不可读取');
}
export function safeDetailReturn(input){return typeof input==='string'&&/^\/(?:work(?:\/[^/?#]+)?|search|projects|files|chat|group-files|personal|profile|notifications|material\/[^/?#]+)(?:\?|$)/.test(input)&&!input.includes('\\')?input:'/work';}

export function workBrief(text){
 if(!text)return '';
 const sentence=String(text).split(/[。；\n]/)[0].split(/[：:]/)[0].trim();
 if(!/[\u4e00-\u9fff]/.test(sentence))return '有新的工作记录';
 return sentence.length>90?sentence.slice(0,90)+'…':sentence;
}

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// A message or saved job already identifies the immutable voice source. Avoid
// two redundant metadata reads; the server still verifies current source rights.
export async function voiceSource(id,hint,saved,resolve,project){
 if(id.startsWith('private:')){
  const ref=id.slice(8);if(!UUID.test(ref))throw Error('这段语音没有可用的固定原件');
  let hash=hint?.sha256;
  if(!hash&&saved?.identity){let previous;try{previous=JSON.parse(saved.identity);}catch{throw Error('转写历史记录无法读取，原记录已保留');}if(previous?.[0]!==project||previous?.[1]!=='private'||previous?.[2]!==id)throw Error('语音原件与历史转写不一致，原记录已保留');hash=previous[3];}
  if(!hash)return resolve();if(!/^[a-f0-9]{64}$/.test(hash))throw Error('语音校验信息不完整，请重新读取消息');
  return {project_id:project,private_attachment_id:id,sha256:hash};
 }
 const parts=id.split(':');
 if(parts.length!==2||parts.some(p=>!UUID.test(p)))throw Error('这段语音没有可用的固定原件');
 const [material_id,version_id]=parts;
 if(hint){
  if(!/^[a-f0-9]{64}$/.test(hint.sha256||''))throw Error('语音校验信息不完整，请重新读取消息');
  return {project_id:project,material_id,version_id,sha256:hint.sha256};
 }
 if(saved?.identity){
  let identity;try{identity=JSON.parse(saved.identity);}catch{throw Error('转写历史记录无法读取，原记录已保留');}
  if(!Array.isArray(identity)||identity.length!==4||identity[0]!==project||identity[1]!==material_id||identity[2]!==version_id||!/^[a-f0-9]{64}$/.test(identity[3]||''))throw Error('语音原件与历史转写不一致，原记录已保留');
  return {project_id:project,material_id,version_id,sha256:identity[3]};
 }
 return resolve();
}

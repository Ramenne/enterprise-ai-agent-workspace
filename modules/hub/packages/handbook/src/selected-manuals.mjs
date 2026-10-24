import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
/** One current publication manifest; immutable version manifests are read explicitly. */
export function selectedManuals(root){
 const manifest=async()=>JSON.parse(await readFile(root+'manifest.json','utf8'));
 const read=async(m,d)=>{
  if(!/^[a-z0-9-]+\.md$/.test(d.filename))throw Error('invalid_manual_filename');
  if(m.release_directory&&!/^releases\/(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(m.release_directory))throw Error('invalid_release_directory');
  const text=await readFile(root+(m.release_directory?m.release_directory+'/':'')+d.filename,'utf8');
  if(createHash('sha256').update(text).digest('hex')!==d.fixed_ref?.sha256)throw Error('publication_refresh_required;read_current_catalog_and_retry');
  return text;
 };
 return {manifest,read};
}

import {hashFile,uploadLogicalPath,NativeError} from './client.mjs';
// A same-path creation conflict may reuse exactly the existing original bytes.
// Never overwrite a different file or accept a merely similar search result.
export async function matchingUpload(client,project_id,file,key,active=()=>{}){
 active();const path=await uploadLogicalPath(key,file.name);active();
 const page=await client.paths(project_id,[path]);active();
 const matches=(page.items||[]).filter(x=>x.logical_path===path);
 if(matches.length!==1)throw new NativeError('upload_path_conflict',409);
 const head=await client.head(project_id,matches[0].material_id);active();
 const hash=await hashFile(file,active);active();
 if(head.fixed_ref?.sha256!==hash||head.fixed_ref?.size!==file.size)throw new NativeError('upload_path_has_different_content',409);
 return head.fixed_ref;
}

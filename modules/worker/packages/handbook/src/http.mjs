import {infrastructureFailure} from '../../platform/src/failure-contract.mjs';
import{installSystemReleases}from'./releases.mjs';
import {selectedManuals} from './selected-manuals.mjs';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root='/srv/workspace';
export function installOfficialManuals(app,pool){
 installSystemReleases(app,pool,root);
 const current=async req=>{const token=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];if(!token||token.length>4096)throw Object.assign(Error('unauthenticated'),{status:401});await pool.query('SELECT authz.authenticate($1)',[createHash('sha256').update(token).digest('hex')]);};
 const selected=selectedManuals(root);
 const manifest=selected.manifest;
 const route=fn=>async(req,reply)=>{reply.header('cache-control','no-store');try{await current(req);return await fn(req);}catch(e){const failure=infrastructureFailure(e);reply.code(e.status??failure?.status??503);return{state:'failed',error_code:e.status?e.message:failure?.code??'manual_dependency_unavailable'};}};
 app.get('/v2/manuals/catalog',{logLevel:'silent'},route(async()=>{const m=await manifest();return{state:'catalog',edition:m.version,system_version:m.system_version??null,system_release:m.system_release??null,coverage:m.coverage??'current_published_system_manuals',documents:m.documents.map(({id,title,updated_at,file_id,fixed_ref})=>({id,title,updated_at,file_id,fixed_ref})),reading:{system:'hufu',method:'POST',path:'/v2/manuals/read',body:{id:'handbook'}},authority:'official_manual_read;does_not_grant_private_project_or_management_rights'};}));
 app.post('/v2/manuals/read',{logLevel:'silent'},route(async req=>{const b=req.body;if(!b||typeof b.id!=='string'||Object.keys(b).some(k=>!['id','version'].includes(k))||b.version!==undefined&&!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(b.version))throw Object.assign(Error('invalid_input'),{status:400});let m=await manifest();if(b.version){if(!(m.release_history??[]).some(x=>x.version===b.version))throw Object.assign(Error('release_not_found'),{status:404});m=JSON.parse(await readFile(root+'releases/'+b.version+'/manifest.json','utf8'));}const d=m.documents.find(x=>x.id===b.id);if(!d||!/^[a-z0-9-]+\.md$/.test(d.filename))throw Object.assign(Error('manual_not_found'),{status:404});const text=await selected.read(m,d);if(createHash('sha256').update(text).digest('hex')!==d.fixed_ref?.sha256)throw Object.assign(Error('publication_refresh_required;read_current_catalog_and_retry'),{status:409});return{state:'read',id:d.id,title:d.title,edition:m.version,system_version:m.system_version??null,updated_at:d.updated_at,text,fixed_ref:d.fixed_ref,source:'current_official_published_manual',coverage:'whole_published_manual',authority:'manual_information_only;actual_tools_and_current_rights_apply'};}));
}

// Patch the verified released v88 runtime; preserve ASR and other adapters.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
const base=resolve('../成员状态与账号设置候选-v88-20261011/server/gateway.runtime.mjs');
const output=resolve('../个人页反馈与引用优化发布-v89-20261011/server');
const original=await readFile(base,'utf8'),hash=s=>createHash('sha256').update(s).digest('hex');
if(hash(original)!=='9ddc5f4936924c471629727a070e7c9bf07c104256b9842a5f8f010eae525434')throw Error('released_v88_baseline_changed');
let candidate=original;
const specs=[['chat-repository','createChatRepository','init_chat_repository'],['http','createBusinessHandler','init_http']];
for(const [module,factory,init] of specs){
 const result=await build({entryPoints:['server/business/'+module+'.mjs'],bundle:true,write:false,format:'esm',platform:'node',external:['node:crypto','./native-authority.mjs','./notification-target.mjs']});
 const text=result.outputFiles[0].text;
 const aliases=[...text.matchAll(/(?:createHash|randomUUID) as (\w+)/g)].map(m=>'const '+m[1]+'=qnExperienceCrypto.'+(m[0].startsWith('createHash')?'createHash':'randomUUID')+';').join('\n');
 const code=text.replace(/^\/\/ (?:server|shared)\/.*$/gm,'').replace(/^import[^\n]*\n/gm,'').replace(/export \{[\s\S]*?\};\s*$/,'');
 const start=candidate.indexOf('// server/business/'+module+'.mjs'),end=candidate.indexOf('// server/business/',start+45);
 if(start<0||end<0)throw Error('missing_module:'+module);
 const next='// server/business/'+module+'.mjs\nvar '+factory+' = (()=>{\nconst {createHash,randomUUID}=qnExperienceCrypto;\n'+aliases+'\n'+code+'\nreturn '+factory+';\n})();\nvar '+init+' = ()=>{};\n\n';
 candidate=candidate.slice(0,start)+next+candidate.slice(end);
}
const replacements=[];
function replace(before,after){
 if(candidate.split(before).length!==2)throw Error('patch_not_unique:'+before.slice(0,90));
 candidate=candidate.replace(before,after);replacements.push({before,after});
}
replace('  const repository = createChatRepository(db), authorize = async (cookie) => (await sessionFactory(cookie)).context;',`  const sessions = new WeakMap(), repository = createChatRepository(db), authorize = async (cookie) => {
    const session = await sessionFactory(cookie);
    sessions.set(session.context, {cookie, session});
    return session.context;
  };
  const requestSession = (ctx, cookie) => {
    const saved = sessions.get(ctx);
    return saved?.cookie === cookie ? Promise.resolve(saved.session) : sessionFactory(cookie);
  };`);
replace('  const reference = async (_ctx, body, cookie) => {','  const reference = async (ctx, body, cookie) => {');
replace('    const session = await sessionFactory(cookie), project = (await session.rpc("v8.project.read", { project_id: PROJECT })).project;',`    const session = await requestSession(ctx, cookie);
    const [projectPage, workPage] = await Promise.all([
      session.rpc("v8.project.read", { project_id: PROJECT }),
      body.work_item_id ? session.rpc("v8.work.read", { project_id: PROJECT, work_item_id: body.work_item_id }) : Promise.resolve(null)
    ]);
    const project = projectPage.project;`);
replace('    const w = (await session.rpc("v8.work.read", { project_id: PROJECT, work_item_id: body.work_item_id })).work_item;','    const w = workPage.work_item;');
replace('  const attachments = async (_ctx, body, cookie) => {','  const attachments = async (ctx, body, cookie) => {');
replace('    const session = await sessionFactory(cookie), result = [];','    if (!body.attachment_ids.length) return [];\n    const session = await requestSession(ctx, cookie), result = [];');
replace('directory: async (_ctx, cookie) => {\n    if (!cookie) fail12("directory_session_required", 503);\n    return (await sessionFactory(cookie)).directory();','directory: async (ctx, cookie) => {\n    if (!cookie) fail12("directory_session_required", 503);\n    return ctx.member_roster || (await requestSession(ctx, cookie)).directory();');
function removeModules(text){for(const [module] of specs){const start=text.indexOf('// server/business/'+module+'.mjs'),end=text.indexOf('// server/business/',start+45);text=text.slice(0,start)+text.slice(end);}return text;}
let restored=candidate;for(const {before,after} of [...replacements].reverse())restored=restored.replace(after,before);
if(removeModules(restored)!==removeModules(original))throw Error('unrelated_runtime_changed');
await mkdir(output,{recursive:true});await writeFile(resolve(output,'gateway.runtime.mjs'),candidate);
await writeFile(resolve(output,'patch-summary.json'),JSON.stringify({baseline_sha256:hash(original),candidate_sha256:hash(candidate),modules:specs.map(x=>x[0]),runtime_replacements:replacements,outside_scope_preserved:true,status:'candidate_not_deployed'},null,2)+'\n');
console.log('v89 runtime candidate ready; unrelated runtime preserved');

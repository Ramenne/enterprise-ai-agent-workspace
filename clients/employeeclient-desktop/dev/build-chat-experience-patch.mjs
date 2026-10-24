// Local candidate only: patch the actual released v86 runtime, retaining its ASR/attachment adapters.
import {readFile,writeFile,mkdir} from 'node:fs/promises';import {build} from 'esbuild';import {createHash} from 'node:crypto';import {resolve} from 'node:path';
const base=resolve('../真机反馈统一整改候选-v86-20261011/server/gateway.runtime.mjs');
const output=resolve('../成员状态与账号设置候选-v88-20261011/server');await mkdir(output,{recursive:true});
const original=await readFile(base,'utf8');
if(createHash('sha256').update(original).digest('hex')!=='423e6bd63f57eb6d9eb59c0391db4bed06fd87b7b5988b904ce47e9298a0fcf9')throw Error('released_baseline_changed');
let candidate=original;
const specs=[['chat-repository','createChatRepository','init_chat_repository'],['http','createBusinessHandler','init_http'],['notification-events','createNotificationEvents','init_notification_events']];
for(const [module,factory,init] of specs){
 const bundled=await build({entryPoints:['server/business/'+module+'.mjs'],bundle:true,write:false,format:'esm',platform:'node',external:['node:crypto','node:events','./native-authority.mjs','./notification-target.mjs']});
 const aliases=[...bundled.outputFiles[0].text.matchAll(/(?:createHash|randomUUID) as (\w+)/g)].map(m=>'const '+m[1]+'=qnExperienceCrypto.'+(m[0].startsWith('createHash')?'createHash':'randomUUID')+';').join('\n');
 let code=bundled.outputFiles[0].text.replace(/^\/\/ (?:server|shared)\/.*$/gm,'').replace(/^import[^\n]*\n/gm,'').replace(/export \{[\s\S]*?\};\s*$/,'');
 const start=candidate.indexOf('// server/business/'+module+'.mjs'),end=candidate.indexOf('// server/business/',start+45);
 if(start<0||end<0)throw Error('module_patch_marker_missing:'+module);
 const next='// server/business/'+module+'.mjs\nvar '+factory+' = (()=>{\nconst {createHash,randomUUID}=qnExperienceCrypto;const {EventEmitter}=qnExperienceEvents;\n'+aliases+'\n'+code+'\nreturn '+factory+';\n})();\nvar '+init+' = ()=>{};\n\n';
 candidate=candidate.slice(0,start)+next+candidate.slice(end);
}
const target='const changed = () => {\n    events.changed();';
if(candidate.split(target).length!==2)throw Error('runtime_changed_hook_not_unique');
candidate=candidate.replace(target,'const changed = (hint) => {\n    events.changed(hint);');
const oldReminders='  const reminders = createNotificationReminders(db, () => {\n    events.changed();\n    drain.wake();\n  });\n  reminders.wake();\n';
if(!candidate.includes(oldReminders))throw Error('reminder_runtime_marker_missing');candidate=candidate.replace(oldReminders,'').replaceAll('    reminders.wake();\n','').replaceAll('    reminders.close();\n','').replaceAll('    init_notification_reminders();\n','');
const rs=candidate.indexOf('// server/business/notification-reminders.mjs'),re=candidate.indexOf('// server/business/',rs+48);if(rs<0||re<0)throw Error('reminder_module_marker_missing');candidate=candidate.slice(0,rs)+candidate.slice(re);
const rosterMarker='    can_publish_announcement: current.can_write === true && current.is_manager === true,\n    legacy_refs: Object.freeze([])';
if(!candidate.includes(rosterMarker))throw Error('native_member_snapshot_marker_missing');candidate=candidate.replace(rosterMarker,'    can_publish_announcement: current.can_write === true && current.is_manager === true,\n    member_roster: members,\n    legacy_refs: Object.freeze([])');
candidate='import * as qnExperienceCrypto from "node:crypto";\nimport * as qnExperienceEvents from "node:events";\n'+candidate;
await writeFile(resolve(output,'gateway.runtime.mjs'),candidate);
await writeFile(resolve(output,'patch-summary.json'),JSON.stringify({baseline_sha256:createHash('sha256').update(original).digest('hex'),candidate_sha256:createHash('sha256').update(candidate).digest('hex'),modules:specs.map(s=>s[0]),status:'local_candidate_not_deployed'},null,2)+'\n');
console.log('Local narrow runtime candidate prepared');

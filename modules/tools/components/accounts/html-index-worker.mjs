// Maintain one common directory using an existing librarian login; no per-reader scans.
import {DatabaseSync} from 'node:sqlite';
import {createDecipheriv,hkdfSync} from 'node:crypto';
import {createHtmlIndexStore} from './html-index.mjs';
import {createCloudLibrary} from './html-cloud.mjs';
import {central} from './hufu-auth.mjs';
import {isAdmin} from './access-control.mjs';
const db=new DatabaseSync(process.env.DATA_PATH||'/srv/workspace');db.exec('PRAGMA busy_timeout=5000');
const cache=createHtmlIndexStore(db),lib=createCloudLibrary({cache});
const secretKey=hkdfSync('sha256',Buffer.from(process.env.XIANYU_KEY,'base64'),Buffer.alloc(0),'xianyu-hufu-session-v1',32);
const only=process.argv.find(x=>x.startsWith('--owner='))?.slice(8),done=new Set();let successes=0,failures=0;
try{
 const rows=db.prepare('SELECT actor,secret FROM hufu_sessions WHERE expires_at>? ORDER BY rowid DESC').all(Date.now());
 for(const row of rows){
  if(!isAdmin(row.actor)||done.has(row.actor)||(only&&row.actor!==only))continue;
  let payload;try{const b=Buffer.from(row.secret,'base64'),d=createDecipheriv('aes-256-gcm',secretKey,b.subarray(0,12));d.setAuthTag(b.subarray(-16));payload=JSON.parse(Buffer.concat([d.update(b.subarray(12,-16)),d.final()]).toString())}catch{continue}
  if(payload.kind!=='tools_remembered')continue;
  const me=await central('/v2/me',{token:payload.token});
  if(!me.ok||me.data?.actor_id!==row.actor||me.data?.credential_id!==payload.credentialId||me.data?.credential_type!=='member_api'||me.data?.until_revoked!==true)continue;
  done.add(row.actor);
  const member={owner:row.actor,token:payload.token,name:me.data.member_label||'成员'},job=lib.start(member,{force:true});
  let result;
  do{await new Promise(r=>setTimeout(r,500));result=lib.status(member,job.jobId)}while(result.state==='running');
  if(result.state==='complete')successes++;else failures++;
  console.log(JSON.stringify({library:'shared',state:result.state,html:result.items.length,projects:result.projectsScanned,warnings:result.warnings.map(w=>({project:w.project,status:w.status,code:w.code,message:w.message}))}));
  break; // One librarian refreshes the single directory; readers never trigger separate scans.
 }
 console.log(JSON.stringify({membersIndexed:successes,failedScopes:failures}));
 if(failures)process.exitCode=1;
}finally{db.close()}

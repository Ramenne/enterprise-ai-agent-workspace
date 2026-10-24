// Loopback synthetic speech only, current own Vault grant; real Qwen ASR.
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {startQuoteReturnPreview} from './quoteReturn.preview.mjs';
import {createVoiceASRProvider} from '../server/business/voice-asr-provider.mjs';
import {PROJECT} from '../server/business/native-authority.mjs';
const expectedActor='acca6883-4cc2-4805-aefe-29d413ce0abd';
function invoke(tool,args){const raw=execFileSync('python3',['/Users/developer/.codex/local-tools/workspace-personal-migration-mcp.py'],{input:JSON.stringify({name:'hub.invoke',arguments:{tool,arguments:args}}),encoding:'utf8',maxBuffer:1024*1024});const r=JSON.parse(raw),v=r.body??r;if(r.status>=400||v.error_code||v.state==='failed')throw Error('own_grant_rejected');return v;}
const identity=invoke('hufu_whoami',{});if(identity.actor_id!==expectedActor)throw Error('fixture_identity_mismatch');
const grant=invoke('hufu.vault.reveal',{key:'model.bailian.beijing.asr'});if(typeof grant.value!=='string')throw Error('ordinary_ASR_key_not_delivered');
const provider=createVoiceASRProvider({api_key:grant.value});grant.value=null;
const path=process.argv[2],receipt=process.argv[3],data=readFileSync(path),hash=createHash('sha256').update(data).digest('hex');
const port=Number(process.env.QN_REAL_TRANSCRIPT_PORT||5421),origin='http://quote-check.localhost:'+port;
let submissions=0,completed=null;const tasks=new Set(),calls=[];
const save=()=>writeFileSync(receipt,JSON.stringify({scope:'synthetic_speech_real_provider_UI;not_production_or_phone',actor_id:expectedActor,source_sha256:hash,source_size:data.length,submissions,tasks:[...tasks],completed,calls},null,2));
const wrapped={recognize:async(bytes,mime,opts)=>{
 if(!bytes.equals(data)||mime!=='audio/wav'||submissions)throw Object.assign(Error('synthetic_fixture_source_or_budget_mismatch'),{not_started:true});
 submissions++;save();const result=await provider.recognize(bytes,mime,{...opts,onAccepted:id=>{tasks.add(id);save();opts.onAccepted?.(id);}});completed={text:result.text,provider_request_id:result.provider_request_id};save();return result;
},resume:async(id,opts)=>{if(!tasks.has(id))throw Error('synthetic_task_scope_mismatch');return provider.resume(id,opts);},status:async(id,opts)=>{if(!tasks.has(id))throw Error('synthetic_task_scope_mismatch');return provider.status(id,opts);}};
const fixed={project_id:PROJECT,material_id:randomUUID(),version_id:'b2d1d4d7-e22d-43b7-a647-27b7f4f3cb88',sha256:hash,size:data.length};
const attachment={id:fixed.material_id+':'+fixed.version_id,name:'合成中文语音.wav',mime:'audio/wav',size:data.length,sha256:hash,ver:1,purpose:'voice',duration_ms:4110,fixed_ref:fixed};
const fixture=startQuoteReturnPreview(port,({scenario,ctx,members})=>{
 scenario.registerSourceFile({...fixed,logical_path:attachment.name,properties:{employeeclient:{purpose:'voice',mime:'audio/wav',duration_ms:4110}}},data);
 const voice=scenario.repository.send(ctx,{body:'真实供应商合成语音验证'},'real-asr-fixture',{members,attachments:[attachment]}).message;
 for(let i=0;i<80;i++)scenario.repository.send(ctx,{body:'真实供应商语音间隔 '+i},'real-asr-fill-'+i,{members});return {voice};
},{host:'quote-check.localhost',scenarioOptions:{voiceProviderLoader:async()=>wrapped}});
const handler=fixture.server.listeners('request')[0];fixture.server.removeAllListeners('request');
fixture.server.on('request',(req,res)=>{const u=new URL(req.url,origin);
 if(u.pathname==='/simulation/real-asr-control'){save();res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({scope:'synthetic only',voice:fixture.voice.id,submissions,completed,calls}));return;}
 if(u.pathname.startsWith('/business/v1/voice-asr/')){calls.push({method:req.method,path:u.pathname});save();}handler(req,res);
});
console.log('SYNTHETIC REAL ASR '+origin+'/simulation/sim-a');
const stop=()=>{fixture.server.closeAllConnections();fixture.server.close(()=>process.exit(0));};process.on('SIGINT',stop);process.on('SIGTERM',stop);

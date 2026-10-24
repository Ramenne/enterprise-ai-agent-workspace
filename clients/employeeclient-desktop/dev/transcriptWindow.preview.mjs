// Actual local ASR job/HTTP path; deterministic provider, no external recognition.
import {startQuoteReturnPreview} from './quoteReturn.preview.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {PROJECT} from '../server/business/native-authority.mjs';
let recognizeCount=0,release;const gate=new Promise(r=>release=r);
const data=Buffer.alloc(44+32000);data.write('RIFF');data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(1,22);data.writeUInt32LE(8000,24);data.writeUInt32LE(16000,28);data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(32000,40);for(let n=0;n<16000;n++)data.writeInt16LE(Math.round(Math.sin(n/8000*2*Math.PI*440)*1000),44+n*2);
const fixed={project_id:PROJECT,material_id:randomUUID(),version_id:'b2d1d4d7-e22d-43b7-a647-27b7f4f3cb88',size:data.length,sha256:createHash('sha256').update(data).digest('hex'),local_version_no:'1'};
const attachment={id:fixed.material_id+':'+fixed.version_id,name:'历史窗口语音.wav',mime:'audio/wav',size:fixed.size,sha256:fixed.sha256,ver:1,purpose:'voice',duration_ms:2000,fixed_ref:fixed};
const fixture=startQuoteReturnPreview(Number(process.env.QN_TRANSCRIPT_PORT||5413),({scenario,ctx,members})=>{
 scenario.registerSourceFile({...fixed,logical_path:attachment.name,properties:{employeeclient:{purpose:'voice',mime:'audio/wav',duration_ms:2000}}},data);
 const voice=scenario.repository.send(ctx,{body:'窗口外语音转写验证'},'transcript-window-voice',{members,attachments:[attachment]}).message;
 for(let i=0;i<80;i++)scenario.repository.send(ctx,{body:'窗口外语音间隔 '+i},'transcript-window-filler-'+i,{members});
 return {voice};
},{host:'quote-check.localhost',scenarioOptions:{voiceProviderLoader:async()=>({recognize:async(bytes,mime)=>{if(!bytes.equals(data)||mime!=='audio/wav')throw Error('source mismatch');recognizeCount++;await gate;return {text:'这是本机固定返回的转写界面验证结果，不是真实识别。'};}})}});
const handler=fixture.server.listeners('request')[0];fixture.server.removeAllListeners('request');const requests=[];
fixture.server.on('request',(req,res)=>{
 const u=new URL(req.url,'http://quote-check.localhost:5413');
 if(u.pathname==='/simulation/transcript-control'){if(u.searchParams.get('mode')==='release')release();res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({scope:'synthetic provider UI only',voice:fixture.voice.id,attachment:attachment.id,recognizeCount,requests}));return;}
 if(u.pathname.startsWith('/business/v1/voice-asr/'))requests.push({method:req.method,path:u.pathname});
 handler(req,res);
});
console.log('SYNTHETIC TRANSCRIPT http://quote-check.localhost:'+(process.env.QN_TRANSCRIPT_PORT||5413)+'/simulation/sim-a');
const stop=()=>{fixture.server.closeAllConnections();fixture.server.close(()=>process.exit(0));};process.on('SIGINT',stop);process.on('SIGTERM',stop);

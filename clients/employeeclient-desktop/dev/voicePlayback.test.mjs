import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundle=await build({entryPoints:['src/chat/voicePlayback.ts'],bundle:true,write:false,format:'esm'});
const {claimVoice,stopVoicePlayback}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
test('pending listening intent owns playback and stale release cannot stop new owner',()=>{
  let stopped=0;
  const first=claimVoice(()=>{stopped++;first.release();});
  const next=claimVoice(()=>{});
  assert.equal(stopped,1);assert.equal(first.current(),false);assert.equal(next.current(),true);
  first.release();assert.equal(next.current(),true);next.release();assert.equal(next.current(),false);
});
test('recording invalidates active playback and pending download ownership',()=>{
  let stopped=0;
  const active=claimVoice(()=>{stopped++;active.release();});
  stopVoicePlayback();stopVoicePlayback();
  assert.equal(stopped,1);assert.equal(active.current(),false);
  const next=claimVoice(()=>{});active.release();assert.equal(next.current(),true);next.release();
});

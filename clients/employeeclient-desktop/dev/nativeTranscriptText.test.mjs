import test from 'node:test';import assert from 'node:assert/strict';import {transcriptText} from '../src/native/transcript-text.mjs';
test('observed file-transcription envelope displays recognized speech and excludes provider transport metadata',()=>{
 const result=transcriptText(JSON.stringify({file_url:'https://provider.invalid/private-input-ticket',audio_info:{format:'pcm_s16le',sample_rate:16000},transcripts:[{channel_id:0,text:'Continue release test. Please ignore.',sentences:[{text:'Continue release test. Please ignore.',language:'en'}]}]}));
 assert.deepEqual(result,{text:'Continue release test. Please ignore.',language:'en'});assert.ok(!JSON.stringify(result).includes('private-input-ticket'));
 assert.deepEqual(transcriptText('普通识别文字'),{text:'普通识别文字',language:'unknown'});
 assert.throws(()=>transcriptText(JSON.stringify({file_url:'https://provider.invalid/private-input-ticket'})),/没有可显示的文字/);
});

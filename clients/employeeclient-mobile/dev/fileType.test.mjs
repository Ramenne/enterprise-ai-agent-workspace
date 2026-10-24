import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';

const source=await readFile(new URL('../src/files/fileType.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {effectiveMime,effectiveKind}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
test('generic desktop or cloud metadata opens common document, picture, video and audio using their real formats',()=>{
 for(const [name,mime,kind] of [
  ['记录.txt','text/plain','file'],['方案.pdf','application/pdf','file'],
  ['照片.JPG','image/jpeg','image'],['影片.mp4','video/mp4','video'],
  ['录音.m4a','audio/mp4','audio'],['数据.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','file'],
 ]){assert.equal(effectiveMime(name,'application/octet-stream'),mime);assert.equal(effectiveKind(name,'application/octet-stream'),kind);}
 assert.equal(effectiveMime('误导.jpg','application/pdf'),'application/pdf','explicit metadata takes precedence');
 assert.equal(effectiveMime('未知.bin',''),'application/octet-stream');
 assert.equal(effectiveMime('会议视频.mp4','VIDEO/MP4; codecs="avc1"'),'video/mp4');
 assert.equal(effectiveKind('会议视频.mp4','VIDEO/MP4; codecs="avc1"'),'video');
 assert.equal(effectiveMime('施工图.PNG',' Application/Octet-Stream; charset=binary '),'image/png');
 assert.equal(effectiveMime('方案.PDF','application/x-octet-stream'),'application/pdf');
 assert.equal(effectiveMime('误导.jpg','APPLICATION/PDF; charset=utf-8'),'application/pdf','an explicit non-generic MIME still wins after normalization');
});

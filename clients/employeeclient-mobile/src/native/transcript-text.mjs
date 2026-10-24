// Project the recognized utterance, never provider transport URLs or raw JSON.
export function transcriptText(original){
 let value;try{value=JSON.parse(original);}catch{
  if(/^\s*[\[{]/.test(original))throw Error('转写结果格式无法识别，请重试读取原结果');
  return {text:original,language:'unknown'};
 }
 if(typeof value==='string')return {text:value,language:'unknown'};
 if(typeof value?.text==='string')return {text:value.text,language:value.language||'unknown'};
 if(typeof value?.transcript==='string')return {text:value.transcript,language:value.language||'unknown'};
 if(Array.isArray(value?.transcripts)){
  const texts=value.transcripts.map(t=>typeof t?.text==='string'?t.text:Array.isArray(t?.sentences)?t.sentences.filter(s=>typeof s?.text==='string').map(s=>s.text).join(''):null);
  if(texts.some(t=>t===null))throw Error('转写结果没有可显示的文字');
  const languages=[...new Set(value.transcripts.flatMap(t=>(t.sentences||[]).map(s=>s.language).filter(x=>typeof x==='string')))];
  return {text:texts.join('\n'),language:languages.length===1?languages[0]:'unknown'};
 }
 throw Error('转写结果没有可显示的文字');
}

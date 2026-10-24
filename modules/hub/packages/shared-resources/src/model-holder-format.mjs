/** Actual Vault may hold one API key or an explicitly labelled key pool. Keep
 * original storage untouched; extract only credential fields inside the holder. */
export function modelCredentialValues(value){
 if(typeof value==='string'){
  let object;try{object=JSON.parse(value)}catch{}
  if(object&&typeof object==='object')return modelCredentialValues(object);
  const clean=value.trim();if(!/[\s\x00-\x1f\x7f-\uffff]/.test(clean))return[clean];
  const values=[...value.matchAll(/(?:api[_ -]?key|access[_ -]?token|密钥|key)\s*[:=：]\s*["']?([A-Za-z0-9._+\/-]{16,}={0,2})/gi)].map(x=>x[1]);
  return [...new Set(values)];
 }
 if(Array.isArray(value))return[...new Set(value.flatMap(modelCredentialValues))];
 if(value&&typeof value==='object'){
  const values=[];for(const field of['api_key','apiKey','key','token'])if(typeof value[field]==='string')values.push(...modelCredentialValues(value[field]));
  if(Array.isArray(value.keys))values.push(...value.keys.flatMap(modelCredentialValues));return [...new Set(values)];
 }
 return[];
}

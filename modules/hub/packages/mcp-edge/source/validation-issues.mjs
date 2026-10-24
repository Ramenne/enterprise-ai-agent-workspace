// Decode only SDK-generated machine requirements. Never return the raw error
// message, submitted values, enum literals, regular expressions, or key names
// from an unrecognized-keys message. Validation/authorization stay upstream.
function fieldPath(value){
 const parts=value.replace(/\[(\d+)\]/g,'.$1').split('.');let dynamic=false;
 return parts.map((part,i)=>{
  if(dynamic)return'*';
  if(!/^(?:[A-Za-z_][A-Za-z0-9_]*|\d{1,4})$/.test(part)||part.length>48||/^hub2_|^AKID/.test(part))return'*';
  if(i>0&&['properties','attributes','metadata','judgment','recipe'].includes(parts[i-1])){dynamic=true;return'*';}
  return part;
 }).join('.');
}
export function sdkValidationIssues(text){
 if(typeof text!=='string'||!text.startsWith('Input validation error:')||text.length>32768)return[];
 const matches=[...text.matchAll(/(?:^|[\s;,])([A-Za-z_][A-Za-z0-9_.\[\]]*):\s*(Too big|Too small|Invalid input|Invalid option|Invalid UUID|Invalid ISO datetime|Unrecognized key|String must contain)/g)],issues=[];
 for(let i=0;i<matches.length&&issues.length<20;i++){
  const match=matches[i],message=text.slice(match.index+match[0].length-match[2].length,matches[i+1]?.index??text.length),requirement={};
  let bound=message.match(/expected (string|array|number|int) to (?:have|be) (<=|>=|<|>)(\d+(?:\.\d+)?)/);
  if(bound){const type=bound[1],op=bound[2],number=Number(bound[3]);requirement.type=type==='int'?'integer':type;const high=op.startsWith('<');requirement[type==='string'?(high?'maxLength':'minLength'):type==='array'?(high?'maxItems':'minItems'):(op.length===1?(high?'exclusiveMaximum':'exclusiveMinimum'):(high?'maximum':'minimum'))]=number;}
  else if((bound=message.match(/String must contain (?:at most|at least) (\d+) character/))){requirement.type='string';requirement[message.includes('at most')?'maxLength':'minLength']=Number(bound[1]);}
  else if(message.startsWith('Invalid input')){const expected=message.match(/expected (string|number|boolean|object|array|int|integer|null)/);if(expected)requirement.type=expected[1]==='int'?'integer':expected[1];if(/received undefined\b/.test(message))requirement.required=true;}
  else if(message.startsWith('Invalid UUID'))requirement.format='uuid';
  else if(message.startsWith('Invalid ISO datetime'))requirement.format='date-time';
  else if(message.startsWith('Unrecognized key'))requirement.additionalProperties=false;
  else if(message.startsWith('Invalid option'))requirement.enum='use_registered_schema_options';
  if(Object.keys(requirement).length)issues.push({path:fieldPath(match[1]),requirement});
 }
 return issues;
}

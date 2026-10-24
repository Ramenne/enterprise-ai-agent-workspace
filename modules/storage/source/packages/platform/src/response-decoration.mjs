/** Display metadata may decorate facts, never mutate executable recovery inputs. */
export function preserveInvocationArguments(original,decorated){
 if(!original||typeof original!=='object'||!decorated||typeof decorated!=='object')return decorated;
 if(Array.isArray(original)&&Array.isArray(decorated))return decorated.map((value,index)=>preserveInvocationArguments(original[index],value));
 if(Array.isArray(original)||Array.isArray(decorated))return decorated;
 const result={...decorated};
 for(const key of Object.keys(result))if(Object.hasOwn(original,key))result[key]=preserveInvocationArguments(original[key],result[key]);
 if(Object.hasOwn(original,'arguments')&&(typeof original.tool==='string'||typeof original.command==='string'))result.arguments=original.arguments;
 return result;
}

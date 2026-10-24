// The copied label uses the authorized owning project, never a work title or guessed name.
export function referenceCopyText(number,projectName){
 const label=String(number||'').trim(),name=typeof projectName==='string'?projectName.trim():'';
 return label&&name?label+' '+name:'';
}

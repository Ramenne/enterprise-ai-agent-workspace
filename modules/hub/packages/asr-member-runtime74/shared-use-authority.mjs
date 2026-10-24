import{decorateASRAuthority}from'./native-asr-use-guard.mjs';
import{RuntimeError}from'./ram-authority.mjs';
export function installSharedUseAuthority(authority,hufuBase){
 return decorateASRAuthority(authority,async(token,body)=>{
  const response=await fetch(new URL('/v2/vault/project-use/job-check',hufuBase),{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();if(!response.ok)throw new RuntimeError(result.error_code??'shared_use_authority_unavailable',response.status,response.status>=500);
  if(result.state!=='authorized'&&result.state!=='no_shared_use_binding')throw new RuntimeError('shared_use_authority_unavailable',403,false);return result;
 });
}

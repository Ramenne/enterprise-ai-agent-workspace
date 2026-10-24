// Public copy stays separate from internal transport and authority diagnostics.
export function isRetryableFailure(error){
 const code=error?.code||'',status=error?.status||0;
 if([401,403,404].includes(status)||['session_changed','unauthenticated','login_required'].includes(code)||error?.name==='AbortError')return false;
 return status===408||status===429||status>=500||['network','session_recovering','authority_request_rejected','business_transport_failed','business_transport_timeout','native_upstream_unavailable','dependency_busy'].includes(code)||error?.name==='TimeoutError'||error instanceof TypeError&&/fetch|network|load failed/i.test(error.message);
}
export function userError(error,fallback='操作暂未完成，请重试'){
 const code=error?.code||'',status=error?.status||0;
 if(code==='session_recovering'||error?.name==='AbortError')return '';
 if(code==='session_changed')return '账号状态已变化，请重试当前操作';
 if(['persistent_login_not_retained','persistent_login_unavailable'].includes(code))return '长期登录信息尚未保存，正在恢复，请重试连接';
 if(status===401||['unauthenticated','login_required'].includes(code))return '本人身份尚未确认，请重试连接';
 if(status===403)return '当前账号没有这项内容或操作的权限';
 if(status===404)return '这份内容已不存在，或当前账号无法读取';
 if(isRetryableFailure(error))return fallback;
 const text=error instanceof Error?error.message:'';
 return text&&/[\u4e00-\u9fff]/.test(text)?text.replace(/^\[[^\]]+\]\s*/,''):fallback;
}

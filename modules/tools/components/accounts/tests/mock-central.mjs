const realFetch=globalThis.fetch;
const fgb='0a664193-f099-408b-ad91-f7fc39fa98e2',jie='46b19322-b0f9-490c-ad90-47989799fd74',viewer='cfe3f0af-af84-4c63-a0d6-2d0677caaddd',other='8662ae87-2e86-405e-aa76-c2b6e807b0b1';
const revoked=new Set();
globalThis.fetch=async (url,options={})=>{
 if(!String(url).startsWith('https://hufu.example.invalid/'))return realFetch(url,options);
 const path=String(url),expiry=new Date(Date.now()+8*3600000).toISOString(),cookieActor=options.headers?.Cookie?.split('central_session_token=')[1]?.split(';')[0]||fgb;
 const token=options.headers?.Authorization?.replace('Bearer ','')||'',actor=token.split(':')[1]||cookieActor;
 if(path.includes('sign-in/email-otp')){const email=JSON.parse(options.body).email,actor=email.startsWith('viewer')?viewer:email.startsWith('jie')?jie:email.startsWith('spoof')?other:fgb;return new Response(JSON.stringify({session:{expiresAt:expiry}}),{headers:{'set-cookie':'central_session_token='+actor+'; Max-Age=28800'}})}
 if(path.includes('get-session'))return Response.json({session:{token:'primary:'+cookieActor,expiresAt:expiry}});
 if(path.includes('/portal/api/me'))return Response.json({identity:{actor_id:cookieActor,principal_kind:'member'},user:{name:cookieActor===other?'FGB':'测试成员'}});
 if(path.endsWith('/v2/me'))return revoked.has(token)?Response.json({}, {status:401}):Response.json({actor_id:actor,principal_kind:'member',is_primary:token.startsWith('primary:'),credential_type:token.startsWith('primary:')?'session':'member_api',credential_id:'fixture-'+actor,until_revoked:token.startsWith('remember:'),member_label:actor===other?'FGB':'测试成员'});
 if(path.endsWith('/v2/credentials/create')){revoked.delete('remember:'+actor);return Response.json({credential:'remember:'+actor,credential_id:'fixture-'+actor})}
 if(path.endsWith('/v2/credentials/revoke')){revoked.add(token);return Response.json({state:'revoked'})}
 if(path.includes('/v2/projects/members'))return Response.json({members:[{actor_id:fgb,display_name:'狒狒'},{actor_id:jie,display_name:'杰'},{actor_id:viewer,display_name:'测试成员'},{actor_id:other,display_name:'FGB'}]});
 return Response.json({});
};

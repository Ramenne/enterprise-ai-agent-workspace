const origin='https://employeeclient.example.invalid/';
export async function latestEmployeeClient(fetcher=fetch){
 const r=await fetcher(origin+'/updates/android/latest.json',{redirect:'error',signal:AbortSignal.timeout(10000),headers:{accept:'application/json'}});
 if(!r.ok)throw Error('employeeclient_release_unavailable');
 let chunks=[],size=0;
 for await(const chunk of r.body){size+=chunk.length;if(size>65536)throw Error('employeeclient_release_too_large');chunks.push(Buffer.from(chunk));}
 const release=JSON.parse(Buffer.concat(chunks).toString('utf8')),url=new URL(release.apkUrl);
 if(url.origin!==origin||!/^\/updates\/android\/[a-zA-Z0-9._-]+\.apk$/.test(url.pathname)||url.search||url.hash||url.username||url.password||release.packageName!=='com.workspace.employeeclient'||!Number.isSafeInteger(release.versionCode)||release.versionCode<1||typeof release.versionName!=='string'||release.versionName.length>80)throw Error('employeeclient_release_invalid');
 return{url:url.href,version:release.versionName,versionCode:release.versionCode};
}

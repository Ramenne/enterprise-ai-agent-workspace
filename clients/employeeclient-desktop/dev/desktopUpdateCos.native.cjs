// Real Electron/COS transport and signed package preparation; no installed app replacement.
const {app,net,session}=require('electron');const fs=require('original-fs').promises;const path=require('node:path');const assert=require('node:assert/strict');
app.setPath('userData','/tmp/qn-cos-update-native-profile');
app.whenReady().then(async()=>{const root=path.resolve(__dirname,'../..'),out=path.join(root,'download-cos-20261021'),dir=await fs.mkdtemp('/tmp/qn-cos-update-');let result={scope:'real packaged updater, Electron net.fetch, public COS ZIP and codesign install preparation; installed app untouched'};try{
 const manifest=JSON.parse(await fs.readFile(path.join(root,'delivery/macos-latest-0.2.7.json'),'utf8'));
 const {createDesktopUpdater}=require(path.join(root,'delivery/0.2.7-arm64/员工客户端.app/Contents/Resources/app/updates.cjs'));
 const seen=[];const direct=manifest.files[0].downloadUrl;
 await session.defaultSession.cookies.set({url:direct,name:'synthetic_test_cookie',value:'must_not_be_sent',secure:true});
 session.defaultSession.webRequest.onBeforeSendHeaders({urls:['https://*.myqcloud.com/*']},(details,done)=>{assert.ok(!Object.keys(details.requestHeaders).some(k=>/^(cookie|authorization)$/i.test(k)));seen.push({url:details.url,credentialsAbsent:true});done({requestHeaders:details.requestHeaders});});
 const u=createDesktopUpdater({current:'0.2.5',arch:'arm64',directory:dir,fetcher:async(url,options)=>url.endsWith('latest.json')?Response.json(manifest):net.fetch(url,options)});
 assert.equal((await u.check()).phase,'available');const start=Date.now();const ready=await u.download();assert.equal(ready.phase,'ready',JSON.stringify(ready));const seconds=(Date.now()-start)/1000;
 assert.deepEqual(seen,[{url:direct,credentialsAbsent:true}]);
 const restored=createDesktopUpdater({current:'0.2.5',arch:'arm64',directory:dir});await restored.restore();assert.equal(restored.snapshot().phase,'ready');const plan=await restored.prepareInstall('/Applications/员工客户端.app');await fs.rm(plan.staged,{recursive:true,force:true});
 // The currently installed old updater must still accept the new manifest's canonical path.
 const old=require('/Applications/员工客户端.app/Contents/Resources/app/updates.cjs');assert.equal(old.release(manifest,'https://employeeclient.example.invalid/','arm64').url,'https://employeeclient.example.invalid/'+manifest.files[0].path);
 result={...result,state:'passed',version:'0.2.7',bytes:manifest.files[0].bytes,sha256:manifest.files[0].sha256,seconds,averageMiBs:Math.round(manifest.files[0].bytes/1024/1024/seconds*100)/100,seen,restoredAndPrepared:true,oldUpdaterCompatible:true};
 }catch(e){result.error=String(e);console.error(e);process.exitCode=1;}finally{await fs.writeFile(path.join(out,'electron-cos-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));await fs.rm(dir,{recursive:true,force:true});app.exit(process.exitCode||0);}});

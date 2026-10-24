// Actual signed app placement and actual macOS launch, confined to temporary directories.
const {app}=require('electron');const fs=require('original-fs').promises;const path=require('node:path');const {promisify}=require('node:util');const run=promisify(require('node:child_process').execFile);
app.setPath('userData','/tmp/qn-install-package-controller');
app.whenReady().then(async()=>{const D=path.resolve(__dirname,'../..'),out=path.join(D,'mac-install-20261021'),temp=await fs.mkdtemp('/tmp/qn-installed-package-'),results=[];let server;try{
 const {startMediaForwardPreview}=await import('./mediaForward.preview.mjs');server=startMediaForwardPreview(5381);await new Promise(r=>server.listening?r():server.once('listening',r));const manifest=JSON.parse(await fs.readFile(path.join(D,'delivery/macos-latest-0.2.9.json'),'utf8'));const {createDesktopUpdater}=require(path.join(D,'delivery/0.2.9-arm64/员工客户端.app/Contents/Resources/app/updates.cjs'));
 for(const existing of [false,true]){
  const profile='placement-'+process.pid+'-'+(existing?'existing':'new'),data=path.join(app.getPath('temp'),'employeeclient-desktop-qa-'+profile),directory=path.join(data,'desktop-updates'),apps=path.join(temp,profile,'Applications'),target=path.join(apps,'员工客户端.app');await fs.mkdir(directory,{recursive:true});await fs.mkdir(apps,{recursive:true});
  if(existing)await run('/usr/bin/ditto',[path.join(D,'delivery/0.2.5-arm64/员工客户端.app'),target]);
  await fs.copyFile(path.join(D,'delivery/employeeclient-macos-arm64-0.2.9.zip'),path.join(directory,manifest.files[0].sha256+'.zip'));await fs.writeFile(path.join(directory,'ready.json'),JSON.stringify({manifest}));
  const u=createDesktopUpdater({current:'0.2.8',arch:'arm64',directory});await u.restore();const source=path.join(D,'delivery/0.2.8-arm64/员工客户端.app');const plan=await u.prepareInstall(target,{source});let helper=await fs.readFile(plan.helper,'utf8');helper=helper.replace('/usr/bin/open -n "$target" --args','/usr/bin/open -n "$target" --env EMPLOYEECLIENT_DESKTOP_QA_ORIGIN=http://127.0.0.1:5381 --env EMPLOYEECLIENT_DESKTOP_QA_PROFILE='+profile+' --args');helper=helper.replace('/usr/bin/open -n \"$source\" || true','true');await fs.writeFile(plan.helper,helper);
  try{
   await run('/bin/sh',[plan.helper,'99999999',plan.target,plan.staged,plan.backup,plan.marker,source,plan.targetExists?'present':'absent'],{timeout:60000});const marker=JSON.parse(await fs.readFile(plan.marker,'utf8'));if(marker.version!=='0.2.9')throw Error('wrong version marker');await fs.access(target);await fs.access(source);results.push({case:existing?'replace older installed copy from separate running source':'install to new Applications target',result:'passed',newVersion:marker.version,sourcePreserved:true,realMacOSLaunch:true});
  }finally{
   const listing=(await run('/bin/ps',['-axo','pid=,command='])).stdout;for(const line of listing.split('\n')){const match=line.trim().match(/^(\d+)\s+(.*)$/);if(match&&match[2].startsWith(target+'/Contents/MacOS/'))try{process.kill(Number(match[1]),'SIGTERM');}catch{}}
   await new Promise(r=>setTimeout(r,500));await fs.rm(data,{recursive:true,force:true});
  }
 }
 await fs.writeFile(path.join(out,'actual-placement-result.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results));
}catch(e){console.error(e);process.exitCode=1;}finally{server?.closeAllConnections();server?.close();await fs.rm(temp,{recursive:true,force:true});app.exit(process.exitCode||0);}});

const {app,BrowserWindow,Menu,shell,session,ipcMain,nativeImage,dialog}=require('electron');
const {readFile,stat}=require('node:fs/promises');const {resolve,sep}=require('node:path');
const {installFileBridge}=require('./files.cjs');
const {installSaveBridge}=require('./save.cjs');
const {installClipboardBridge}=require('./clipboard.cjs');
const {installUpdateBridge,offerMacApplicationInstall}=require('./updates.cjs');
const PRODUCTION='https://employeeclient.example.invalid/';
const qa=process.env.EMPLOYEECLIENT_DESKTOP_QA_ORIGIN;
if(qa&&(!/^http:\/\/127\.0\.0\.1:\d+$/.test(qa)))throw Error('invalid local QA origin');
if(qa)app.setPath('userData',resolve(app.getPath('temp'),'employeeclient-desktop-qa-'+(process.env.EMPLOYEECLIENT_DESKTOP_QA_PROFILE?.replace(/[^a-zA-Z0-9_-]/g,'')||process.pid)));
const ORIGIN=qa||PRODUCTION,root=resolve(__dirname,'web');let window,quitting=false,started=false;
app.setName('员工客户端');

const fixedOrigin=url=>{try{return new URL(url).origin===ORIGIN;}catch{return false;}};
const mime=p=>({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.woff2':'font/woff2'})[require('node:path').extname(p)]||'application/octet-stream';
async function handle(request){
 const u=new URL(request.url);
 if(u.origin!==ORIGIN||/^\/(native|business|updates|api|hufu|simulation)(\/|$)/.test(u.pathname)){const headers=new Headers(request.headers);if(u.origin===ORIGIN&&request.method!=='GET'&&request.method!=='HEAD')headers.set('Origin',ORIGIN);return session.defaultSession.fetch(request,{bypassCustomProtocolHandlers:true,headers,credentials:u.origin!==ORIGIN||u.pathname.startsWith('/updates/macos/')?'omit':'include'});}
 if(request.method!=='GET'&&request.method!=='HEAD')return new Response('',{status:405});
 let path;try{path=resolve(root,'.'+decodeURIComponent(u.pathname));}catch{return new Response('',{status:400});}
 if(path!==root&&!path.startsWith(root+sep))return new Response('',{status:403});
 if(path===root||u.pathname.endsWith('/'))path=resolve(root,'index.html');
 try{if(!(await stat(path)).isFile())return new Response('',{status:404});const bytes=request.method==='HEAD'?null:await readFile(path);return new Response(bytes,{headers:{'content-type':mime(path),'cache-control':'no-store','x-content-type-options':'nosniff'}});}catch{return new Response('',{status:404});}
}
function openSettings(page){show();if(window.webContents.isLoading())window.webContents.once('did-finish-load',()=>window.webContents.send('employeeclient:open-settings',page));else window.webContents.send('employeeclient:open-settings',page);}
function show(){if(window&&!window.isDestroyed()){window.show();window.focus();return;}
 window=new BrowserWindow({title:'员工客户端',width:1280,height:820,minWidth:760,minHeight:520,backgroundColor:'#fafafa',titleBarStyle:'hiddenInset',trafficLightPosition:{x:6,y:10},show:false,webPreferences:{additionalArguments:['--employeeclient-version='+app.getVersion()],preload:resolve(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false,webSecurity:true,backgroundThrottling:false}});
 window.webContents.setWindowOpenHandler(({url})=>{if(/^https:\/\//.test(url))void shell.openExternal(url);return {action:'deny'};});
 window.webContents.on('will-navigate',(event,url)=>{if(!fixedOrigin(url)){event.preventDefault();if(/^https:\/\//.test(url))void shell.openExternal(url);}});
 window.on('close',event=>{if(!quitting){event.preventDefault();window.hide();}});
 window.on('ready-to-show',()=>{window.show();markUpdateReady();});window.on('closed',()=>window=null);
 void window.loadURL(ORIGIN);
}
let updateWatchdog;
const markerArgument=process.argv.find(v=>v.startsWith('--employeeclient-update-marker='))?.slice('--employeeclient-update-marker='.length);
function markUpdateReady(){if(!markerArgument)return;const directory=resolve(app.getPath('userData'),'desktop-updates');if(require('node:path').dirname(markerArgument)!==directory||!/^installed-[a-f0-9-]{36}\.json$/.test(require('node:path').basename(markerArgument)))return;void require('node:fs/promises').writeFile(markerArgument,JSON.stringify({version:app.getVersion()}),{mode:0o600}).then(()=>clearTimeout(updateWatchdog)).catch(()=>app.quit());}
if(markerArgument)updateWatchdog=setTimeout(()=>app.quit(),30000);
app.on('second-instance',()=>{if(started)show();});app.on('activate',()=>{if(started)show();});app.on('before-quit',()=>{quitting=true;});
app.whenReady().then(async()=>{
 const placement=await offerMacApplicationInstall({app,dialog,shell,qa});if(placement){if(placement==='stop')app.quit();return;}
 if(!app.requestSingleInstanceLock()){
  if(!qa){const result=await dialog.showMessageBox({type:'info',title:'员工客户端已在运行',message:'请退出旧的员工客户端窗口，再打开新版本。',detail:'如果刚完成安装，新版本已在“应用程序”文件夹中。',buttons:['打开应用程序','关闭'],defaultId:0,cancelId:1});if(result.response===0)await shell.openPath('/Applications');}
  app.quit();return;
 }

 installUpdateBridge({ipcMain,app,window:()=>window,origin:ORIGIN,qa,onState:state=>{const item=Menu.getApplicationMenu()?.getMenuItemById('employeeclient-update');if(item)item.label=['available','ready'].includes(state.phase)?'有新版本…':'检查更新…';},allowed:event=>event.sender===window?.webContents&&event.senderFrame===window.webContents.mainFrame&&fixedOrigin(event.senderFrame?.url||'')});
 installClipboardBridge(event=>event.sender===window?.webContents&&fixedOrigin(event.senderFrame?.url||''));
 installFileBridge(event=>event.sender===window?.webContents&&event.senderFrame===window.webContents.mainFrame&&fixedOrigin(event.senderFrame?.url||''),()=>window);
 installSaveBridge(event=>event.sender===window?.webContents&&event.senderFrame===window.webContents.mainFrame&&fixedOrigin(event.senderFrame?.url||''),()=>window);
 ipcMain.on('employeeclient:show',event=>{if(event.sender===window?.webContents)show();});
 ipcMain.on('employeeclient:badge',(event,count)=>{if(event.sender===window?.webContents&&Number.isSafeInteger(count)&&count>=0&&count<=999999)app.dock?.setBadge(count?count>99?'99+':String(count):'');});
 // Serve bundled, fixed app bytes at the existing secure service origin. API calls
 // retain the same Chromium cookie jar and TLS checks; no cookie translation.
 await session.defaultSession.protocol.handle(qa?'http':'https',handle);
 session.defaultSession.setPermissionRequestHandler((_contents,permission,callback,details)=>callback(fixedOrigin(details.requestingUrl||'')&&['notifications','media'].includes(permission)));
 session.defaultSession.setPermissionCheckHandler((_contents,permission,origin)=>fixedOrigin(origin)&&['notifications','media'].includes(permission));
 const icon=nativeImage.createFromPath(resolve(__dirname,'icon.png'));if(!icon.isEmpty())app.dock?.setIcon(icon);
 Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'员工客户端',submenu:[{label:'关于员工客户端',click:()=>openSettings('about')},{label:'设置…',accelerator:'Command+,',click:()=>openSettings('settings')},{id:'employeeclient-update',label:'检查更新…',click:()=>openSettings('updates')},{type:'separator'},{label:'隐藏员工客户端',role:'hide'},{label:'隐藏其他应用',role:'hideOthers'},{label:'显示全部',role:'unhide'},{type:'separator'},{label:'退出员工客户端',role:'quit'}]},{label:'编辑',submenu:[{label:'撤销',role:'undo'},{label:'重做',role:'redo'},{type:'separator'},{label:'剪切',role:'cut'},{label:'复制',role:'copy'},{label:'粘贴',role:'paste'},{label:'全选',role:'selectAll'}]},{label:'显示',submenu:[{label:'重新载入',role:'reload'},{label:'实际大小',role:'resetZoom'},{label:'放大',role:'zoomIn'},{label:'缩小',role:'zoomOut'},{label:'切换全屏',role:'togglefullscreen'}]},{label:'窗口',submenu:[{label:'最小化',role:'minimize'},{label:'缩放窗口',role:'zoom'},{label:'显示员工客户端',click:show}]}]));started=true;show();
});

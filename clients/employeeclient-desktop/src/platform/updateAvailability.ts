import {computed,ref} from 'vue';
import {desktopBridge,type DesktopUpdateState} from './desktop';
import {createDesktopUpdateNotice,desktopHasUpdate} from './desktopUpdateNotice.mjs';
import {App} from '@capacitor/app';
import {isAndroidNative} from '@/session/installation';
import {checkAndroidUpdate,type AvailableVersion} from './androidUpdate';
import {CLIENT_RELEASE} from '@/app/release';
import {createUpdateNotice,bindUpdateNotice} from './updateNotice.mjs';
const key='qn.available-release-v1';
let cached=0;try{cached=Number(localStorage.getItem(key))||0;}catch{}
export const latestUpdate=ref<AvailableVersion|null>(null);
export const checkingUpdate=ref(false);
export const updateCheckError=ref('');
const knownVersion=ref(cached);
export const desktopUpdate=ref<DesktopUpdateState|null>(null);
const desktop=desktopBridge();
const desktopDiscovery=desktop?createDesktopUpdateNotice({bridge:desktop,onChange:(value:DesktopUpdateState)=>desktopUpdate.value=value}):null;
export const hasAppUpdate=computed(()=>desktop?desktopHasUpdate(desktopUpdate.value):knownVersion.value>CLIENT_RELEASE.versionCode);
async function readAvailable():Promise<AvailableVersion>{
 if(isAndroidNative())return checkAndroidUpdate();
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
 try{const response=await fetch('/updates/android/latest.json',{cache:'no-store',signal:controller.signal});if(!response.ok)throw Error('update_channel_unavailable');
  const text=await response.text();if(text.length>32768)throw Error('update_manifest_invalid');const value=JSON.parse(text);
  if(value.packageName!=='com.workspace.employeeclient'||typeof value.versionName!=='string')throw Error('update_manifest_invalid');
  return {versionCode:value.versionCode,versionName:value.versionName,notes:typeof value.notes==='string'?value.notes:'',size:value.size,currentVersionCode:CLIENT_RELEASE.versionCode,currentVersionName:CLIENT_RELEASE.versionName,available:value.versionCode>CLIENT_RELEASE.versionCode,downloaded:false};
 }finally{clearTimeout(timer);}
}
const discovery=createUpdateNotice({read:readAvailable,onChange:(value:AvailableVersion)=>{
 latestUpdate.value=value;knownVersion.value=value.versionCode;
 try{localStorage.setItem(key,String(value.versionCode));}catch{}
}});
export async function checkDesktopUpdate(force=false){return desktopDiscovery?.check(force);}
export async function checkAppUpdate(force=true){
 if(desktop)return checkDesktopUpdate(force);
 checkingUpdate.value=true;updateCheckError.value='';
 try{await discovery.check(force);return latestUpdate.value;}
 catch(e){updateCheckError.value=e instanceof Error?e.message:'update_failed';throw e;}
 finally{checkingUpdate.value=false;}
}
let started=false;
export function startUpdateNotices(){
 if(started)return;started=true;desktopDiscovery?.start();const discover=()=>checkAppUpdate(false);bindUpdateNotice(discover);
 if(isAndroidNative())void App.addListener('resume',()=>{void discover().catch(()=>{});}).catch(()=>{});
}

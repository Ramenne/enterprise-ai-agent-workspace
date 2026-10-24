import {App} from '@capacitor/app';
import {isAndroidNative} from '@/session/installation';
import {requestLocalNotifyPermission} from './localNotify';
import {BackgroundSettings} from './backgroundAccess';

let flight:Promise<void>|undefined;
/** Serial native system prompts; never open them from a background receiver. */
export function requestMessageAccess(valid:()=>boolean){
 if(!isAndroidNative())return Promise.resolve();
 if(flight)return flight;
 const work=(async()=>{
  if(!valid()||!(await App.getState()).isActive)return;
  await requestLocalNotifyPermission();
  if(!valid()||!(await App.getState()).isActive)return;
  const status=await BackgroundSettings.status();
  if(status.batteryUnrestricted)return;
  const key='qn.battery-system-prompt.v1';
  if(localStorage.getItem(key)==='shown')return;
  // Record only that a prompt was attempted, never that permission was granted.
  localStorage.setItem(key,'shown');
  try{await BackgroundSettings.open({target:'battery'});}catch{localStorage.removeItem(key);}
 })().catch(()=>{}).finally(()=>{if(flight===work)flight=undefined;});
 flight=work;return work;
}

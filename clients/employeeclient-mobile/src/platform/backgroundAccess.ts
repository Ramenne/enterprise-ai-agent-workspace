import {registerPlugin} from '@capacitor/core';
import {isAndroidNative} from '@/session/installation';
export type BackgroundAccess={batteryUnrestricted:boolean;notifications:boolean;chatChannelImportance:number;manufacturer:string;autostart:'unknown';receiverRunning:boolean};
export const BackgroundSettings=registerPlugin<{status():Promise<BackgroundAccess>;open(o:{target:'battery'|'autostart'|'notifications'}):Promise<{opened:boolean;permissionConfirmed:false}>}>('EmployeeClientBackground');
export async function backgroundAccess(){return isAndroidNative()?BackgroundSettings.status():null;}

import {registerPlugin} from '@capacitor/core';
import {isAndroidNative} from './installation';
import {ensurePwaStoragePersistence} from './persistentStorage.mjs';
const vault=registerPlugin<{restore(options?:{force?:boolean}):Promise<void>;save():Promise<void>;clear():Promise<void>}>('EmployeeClientLogin');
export const deviceLoginStorage={
 async restore(){if(isAndroidNative())await vault.restore();},
 async recover(){if(isAndroidNative())await vault.restore({force:true});},
 async save(){if(isAndroidNative())await vault.save();else void ensurePwaStoragePersistence();},
 async clear(){if(isAndroidNative())await vault.clear();},
};

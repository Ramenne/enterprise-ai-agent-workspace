package com.workspace.employeeclient;

import android.app.NotificationManager;
import android.content.ComponentName;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;

/** User-confirmed system settings only. Opening an OEM page never proves permission. */
@CapacitorPlugin(name="EmployeeClientBackground")
public class EmployeeClientBackgroundPlugin extends Plugin {
 @PluginMethod public void status(PluginCall call){
  JSObject out=new JSObject();
  PowerManager power=(PowerManager)getContext().getSystemService(android.content.Context.POWER_SERVICE);
  out.put("batteryUnrestricted",Build.VERSION.SDK_INT<23||power.isIgnoringBatteryOptimizations(getContext().getPackageName()));
  out.put("notifications",NotificationManagerCompat.from(getContext()).areNotificationsEnabled());
  NotificationManager nm=(NotificationManager)getContext().getSystemService(android.content.Context.NOTIFICATION_SERVICE);
  android.app.NotificationChannel channel=Build.VERSION.SDK_INT>=26?nm.getNotificationChannel("employeeclient_work"):null;
  out.put("chatChannelImportance",channel==null?-1:channel.getImportance());
  out.put("manufacturer",Build.MANUFACTURER);out.put("autostart","unknown");
  out.put("receiverRunning",EmployeeClientLiveService.instance!=null);
  call.resolve(out);
 }
 @PluginMethod public void open(PluginCall call){
  String target=call.getString("target","");Intent intent;
  if("battery".equals(target)&&Build.VERSION.SDK_INT>=23){
   intent=new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,Uri.parse("package:"+getContext().getPackageName()));
  }else if("notifications".equals(target)){
   intent=new Intent(Build.VERSION.SDK_INT>=26?Settings.ACTION_APP_NOTIFICATION_SETTINGS:Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
   if(Build.VERSION.SDK_INT>=26){intent.putExtra(Settings.EXTRA_APP_PACKAGE,getContext().getPackageName());}
   else intent.setData(Uri.parse("package:"+getContext().getPackageName()));
  }else if("autostart".equals(target)){
   String[][] pages={{"com.miui.securitycenter","com.miui.permcenter.autostart.AutoStartManagementActivity"},{"com.huawei.systemmanager","com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"},{"com.coloros.safecenter","com.coloros.safecenter.permission.startup.StartupAppListActivity"},{"com.vivo.permissionmanager","com.vivo.permissionmanager.activity.BgStartUpManagerActivity"}};
   for(String[] page:pages){Intent candidate=new Intent().setComponent(new ComponentName(page[0],page[1]));if(launch(candidate)){JSObject out=new JSObject();out.put("opened",true);out.put("permissionConfirmed",false);call.resolve(out);return;}}
   intent=new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.parse("package:"+getContext().getPackageName()));
  }else{call.reject("unknown_background_setting");return;}
  boolean opened=launch(intent);
  if(!opened)opened=launch(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.parse("package:"+getContext().getPackageName())));
  if(!opened){call.reject("system_settings_unavailable");return;}
  JSObject out=new JSObject();out.put("opened",true);out.put("permissionConfirmed",false);call.resolve(out);
 }
 private boolean launch(Intent intent){try{intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);getContext().startActivity(intent);return true;}catch(Exception ignored){return false;}}
}

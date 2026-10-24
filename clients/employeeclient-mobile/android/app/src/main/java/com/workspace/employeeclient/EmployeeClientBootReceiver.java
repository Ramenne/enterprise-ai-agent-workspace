package com.workspace.employeeclient;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import androidx.core.content.ContextCompat;

/** Resume the existing account receiver after reboot/update, never create an identity. */
public class EmployeeClientBootReceiver extends BroadcastReceiver {
 @Override public void onReceive(Context context,Intent intent){
  if(intent==null||!(Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())||Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())))return;
  if(!context.getSharedPreferences("employeeclient-live",0).getBoolean("restart_allowed",false))return;
  try{ContextCompat.startForegroundService(context,new Intent(context,EmployeeClientLiveService.class).putExtra("restore_saved",true));}catch(Exception ignored){/* OEM/user restrictions remain authoritative; next foreground open retries. */}
 }
}

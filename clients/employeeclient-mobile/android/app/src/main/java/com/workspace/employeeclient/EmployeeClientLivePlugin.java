package com.workspace.employeeclient;
import android.content.Intent;
import androidx.core.content.ContextCompat;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;
import java.lang.ref.WeakReference;

/** Thin UI bridge; the foreground service owns transport and presentation. */
@CapacitorPlugin(name="EmployeeClientLive")
public class EmployeeClientLivePlugin extends Plugin {
 private final EmployeeClientLiveService.Listener receiver=(type,data,status,generation)->{
  JSObject value=new JSObject();value.put("type",type);value.put("data",data);value.put("status",status);value.put("generation",generation);
  notifyListeners("stream",value);
 };
 @Override public void load(){EmployeeClientLiveService.listener=new WeakReference<>(receiver);opened(getActivity().getIntent());}
 @PluginMethod public void start(PluginCall call){
  String url=call.getString("url",""),account=call.getString("account","");
  if(!EmployeeClientLiveService.validEndpoint(getContext(),url,account)){call.reject("invalid_stream_configuration");return;}
  try{
   EmployeeClientLiveService.listener=new WeakReference<>(receiver);
   Intent intent=new Intent(getContext(),EmployeeClientLiveService.class).putExtra("url",url).putExtra("account",account)
     .putExtra("generation",call.getString("generation","")).putExtra("sound",call.getBoolean("sound",true));
   ContextCompat.startForegroundService(getContext(),intent);call.resolve();
  }catch(Exception e){call.reject("background_connection_start_failed");}
 }
 @PluginMethod public void stop(PluginCall call){EmployeeClientLiveService.disableRestart(getContext());if(EmployeeClientLiveService.instance!=null)EmployeeClientLiveService.instance.cancelAccount();getContext().stopService(new Intent(getContext(),EmployeeClientLiveService.class));call.resolve();}
 @PluginMethod public void resume(PluginCall call){
  EmployeeClientLiveService service=EmployeeClientLiveService.instance;if(service==null){call.reject("background_connection_not_running");return;}
  EmployeeClientLiveService.listener=new WeakReference<>(receiver);service.resumeConnection();call.resolve();
 }
 @PluginMethod public void setSound(PluginCall call){if(EmployeeClientLiveService.instance!=null)EmployeeClientLiveService.instance.setSound(call.getBoolean("sound",true));call.resolve();}
 @PluginMethod public void present(PluginCall call){try{
  EmployeeClientLiveService service=EmployeeClientLiveService.instance;if(service==null)throw new Exception();
  int count=service.present(call.getString("account",""),call.getArray("notifications",new JSArray()),call.getBoolean("catchup",false),call.getBoolean("sound",true));
  JSObject result=new JSObject();result.put("presented",count);call.resolve(result);
 }catch(Exception e){call.reject("notification_display_failed");}}
 private void opened(Intent intent){
  if(intent==null||!intent.hasExtra("qn_notification"))return;
  try{notifyListeners("opened",JSObject.fromJSONObject(new JSONObject(intent.getStringExtra("qn_notification"))),true);}catch(Exception ignored){}
  intent.removeExtra("qn_notification");
 }
 @Override protected void handleOnNewIntent(Intent intent){opened(intent);}
 @Override protected void handleOnDestroy(){if(EmployeeClientLiveService.listener.get()==receiver)EmployeeClientLiveService.listener.clear();}
}

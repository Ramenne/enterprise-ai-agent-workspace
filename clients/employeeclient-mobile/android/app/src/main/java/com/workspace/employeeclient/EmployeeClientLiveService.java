package com.workspace.employeeclient;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.Uri;
import android.os.Build;
import android.webkit.CookieManager;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

import android.app.Service;
import android.os.IBinder;
import android.content.pm.ServiceInfo;
import java.lang.ref.WeakReference;

/** User-visible remote-messaging foreground service. No vendor SDK or wake lock. Boot/update resumes only persisted, permitted identity.
 * Activity/WebView destruction does not stop notification reception. Explicit logout does.
 */
public class EmployeeClientLiveService extends Service {
    interface Listener { void receive(String type, JSONObject data, int status, String generation); }
    static volatile EmployeeClientLiveService instance;
    static volatile WeakReference<Listener> listener = new WeakReference<>(null);
    private final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor();
    private final ScheduledExecutorService watchdog = Executors.newSingleThreadScheduledExecutor();
    private final ExecutorService sessionWorker = Executors.newSingleThreadExecutor();
    private boolean sessionRefreshPending;
    private volatile long sessionRefreshRetryAt;
    private volatile HttpURLConnection socket;
    private final java.util.Set<HttpURLConnection> sessionSockets=new java.util.HashSet<>();
    private volatile boolean running, connected, sound = true, identityVerified;
    private volatile int epoch;
    private volatile long lastFrame;
    private volatile long handshakeStartedAt;
    private long sessionStartedAt;
    private volatile long sessionRefreshAt;
    private static final long SESSION_REFRESH_MS = 30 * 60 * 1000L;
    private String endpoint = "", account = "", generation = "";
    private ScheduledFuture<?> retry;
    private int failures;
    private boolean foregroundStarted;
    private volatile int terminalStatus;
    private volatile boolean streamAuthorityRejected;
    private int identityRejections;
    private SharedPreferences prefs;
    private ConnectivityManager connectivity;
    private ConnectivityManager.NetworkCallback networkCallback;


    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public void onCreate() {
        super.onCreate(); instance=this;
        prefs=getSharedPreferences("employeeclient-live", Context.MODE_PRIVATE);
        connectivity=(ConnectivityManager)getSystemService(Context.CONNECTIVITY_SERVICE);
        networkCallback=new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network network) { wake(true); }
            @Override public void onLost(Network network) { wake(true); }
        };
        if (Build.VERSION.SDK_INT>=24) connectivity.registerDefaultNetworkCallback(networkCallback);
        // The reader timeout alone is insufficient: partial bytes can keep a dead
        // SSE frame alive forever. Run independently of the blocked reader.
        watchdog.scheduleWithFixedDelay(this::checkConnection,15,15,TimeUnit.SECONDS);
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        boolean systemRecovery=intent==null||intent.getBooleanExtra("restore_saved",false);
        long recoveredSessionStart=prefs.getLong("restart_session_start",0);
        if(systemRecovery) {
            if(!prefs.getBoolean("restart_allowed",false)) { stopSelf(); return START_NOT_STICKY; }
            intent=new Intent(this,EmployeeClientLiveService.class)
                .putExtra("url",prefs.getString("restart_url",""))
                .putExtra("account",prefs.getString("restart_account",""))
                .putExtra("generation","").putExtra("sound",prefs.getBoolean("restart_sound",true));
        }
        if(!validEndpoint(this,intent.getStringExtra("url"),intent.getStringExtra("account"))) { disableRestart(this);stopSelf(); return START_NOT_STICKY; }
        if(!prefs.edit().putBoolean("restart_allowed",true)
            .putString("restart_url",intent.getStringExtra("url"))
            .putString("restart_account",intent.getStringExtra("account"))
            .putBoolean("restart_sound",intent.getBooleanExtra("sound",true)).commit()) { stopSelf();return START_NOT_STICKY; }
        if(!foregroundStarted){
        NotificationManager manager=(NotificationManager)getSystemService(Context.NOTIFICATION_SERVICE);
        if(Build.VERSION.SDK_INT>=26)manager.createNotificationChannel(new NotificationChannel("employeeclient_connection","后台消息连接",NotificationManager.IMPORTANCE_LOW));
        Intent open=new Intent(this,MainActivity.class);
        PendingIntent click=PendingIntent.getActivity(this,0,open,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        android.app.Notification notice=new NotificationCompat.Builder(this,"employeeclient_connection")
            .setSmallIcon(getApplicationInfo().icon).setContentTitle("员工客户端消息连接")
            .setContentText("消息连接已开启").setOngoing(true).setOnlyAlertOnce(true).setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_MIN).setContentIntent(click).build();
        if(Build.VERSION.SDK_INT>=34)startForeground(761,notice,ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);
        else startForeground(761,notice);
        foregroundStarted=true;
        }
        configure(intent,systemRecovery?recoveredSessionStart:0);
        prefs.edit().putLong("restart_session_start",sessionStartedAt).apply();
        return START_STICKY;
    }
    static boolean validEndpoint(Context context,String url,String actor) {
        try {
            URL u=new URL(url);
            boolean local=(context.getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE)!=0 && "http".equals(u.getProtocol()) && ("127.0.0.1".equals(u.getHost())||"10.0.2.2".equals(u.getHost())||"localhost".equals(u.getHost()));
            return actor!=null&&!actor.isEmpty()&&u.getUserInfo()==null&&u.getQuery()==null&&u.getRef()==null&&
                (local||"https".equals(u.getProtocol())&&"service.example.invalid".equals(u.getHost())&&u.getPort()==-1)&&"/business/v1/events".equals(u.getPath());
        }catch(Exception e){return false;}
    }
    private synchronized void configure(Intent intent,long recoveredStart) {
        String actor=intent.getStringExtra("account");
        String url=intent.getStringExtra("url");
        // Reopening the WebView reattaches its listener, not the live socket.
        if(running && account.equals(actor) && endpoint.equals(url)) {
            generation=intent.getStringExtra("generation");
            sound=intent.getBooleanExtra("sound",true);
            resumeConnection(); return;
        }
        if(!running||!account.equals(actor)){sessionStartedAt=recoveredStart>0?recoveredStart:System.currentTimeMillis();sessionRefreshAt=0;}
        if(!account.isEmpty()&&!account.equals(actor)){
            cancelAccount();
        }
        stopWorker(); endpoint=intent.getStringExtra("url");account=actor;generation=intent.getStringExtra("generation");
        sound=intent.getBooleanExtra("sound",true);identityVerified=false;streamAuthorityRejected=true;running=true;failures=0;terminalStatus=0;identityRejections=0;schedule(epoch,0);
    }
    void resumeConnection() {
        wake();
        if(terminalStatus!=0)event("auth",new JSONObject(),terminalStatus,generation);
        else if(connected){JSONObject data=new JSONObject();try{data.put("resumed",true);data.put("catchup",true);}catch(Exception ignored){}event("ready",data,0,generation);}
        else event("backoff",new JSONObject(),0,generation);
    }
    void cancelAccount(){
        try{JSONObject log=new JSONObject(prefs.getString("shown:"+account,"{}"));NotificationManager manager=(NotificationManager)getSystemService(Context.NOTIFICATION_SERVICE);
        java.util.Iterator<String> keys=log.keys();while(keys.hasNext())manager.cancel(keys.next(),1);}catch(Exception ignored){}
    }
    static void disableRestart(Context context){
        context.getSharedPreferences("employeeclient-live",Context.MODE_PRIVATE).edit()
            .putBoolean("restart_allowed",false).remove("restart_account").remove("restart_url").remove("restart_session_start").commit();
    }
    void setSound(boolean value){sound=value;prefs.edit().putBoolean("restart_sound",value).apply();}
    int present(String actor,JSONArray rows,boolean catchup,boolean audible)throws Exception{
        if(!actor.equals(account))throw new Exception("notification_identity_changed");
        return presentNative(actor,rows,catchup,audible);
    }
    @Override public void onDestroy() {
        stopWorker(); if(instance==this)instance=null;
        if(networkCallback!=null&&Build.VERSION.SDK_INT>=24)connectivity.unregisterNetworkCallback(networkCallback);
        watchdog.shutdownNow();worker.shutdownNow();sessionWorker.shutdownNow();super.onDestroy();
    }
    private synchronized void stopWorker() {
        epoch++; running = false; connected = false;
        if (retry != null) retry.cancel(false);
        HttpURLConnection old = socket; socket = null;
        if (old != null) old.disconnect();
        for(HttpURLConnection renewal:sessionSockets)renewal.disconnect();
        sessionSockets.clear();
    }
    private synchronized void schedule(int e, long delay) {
        if (!running || e != epoch) return;
        if (retry != null) retry.cancel(false);
        retry = worker.schedule(() -> receive(e), delay, TimeUnit.MILLISECONDS);
    }
    private synchronized void checkConnection() {
        // Do not reset a scheduled backoff or a bounded identity refresh.
        if(!running || socket==null)return;
        if(connected){wake(false);return;}
        long now=android.os.SystemClock.elapsedRealtime();
        // Byte arrival is not protocol readiness. Even a never-ending partial
        // ready frame must expire, independently of socket readTimeout.
        if(handshakeStartedAt>0 && (now<handshakeStartedAt || now-handshakeStartedAt>=45000))wake(true);
    }
    private void wake() { wake(false); }
    private synchronized void wake(boolean networkChanged) {
        if (!running) return;
        if (!LiveConnectionPolicy.shouldRebuild(connected,System.currentTimeMillis(),lastFrame,networkChanged)) return;
        epoch++; connected = false;
        HttpURLConnection old = socket; socket = null;
        if (old != null) old.disconnect();
        for(HttpURLConnection renewal:sessionSockets)renewal.disconnect();
        sessionSockets.clear();
        schedule(epoch, 0);
    }
    private void event(String type, JSONObject data, int status, String gen) {
        Listener l = listener.get(); if (l != null) l.receive(type, data, status, generation);
    }
    private void receive(int e) {
        final String a,gen,url;
        synchronized(this){if(!running||e!=epoch)return;a=account;gen=generation;url=endpoint;identityVerified=false;}
        HttpURLConnection c = null;
        try {
            long cursor = prefs.getLong("cursor:" + a, -1);
            c = (HttpURLConnection) new URL(url + (cursor >= 0 ? "?after_version=" + cursor : "")).openConnection();
            synchronized (this) { if (!running || e != epoch) return; socket = c; handshakeStartedAt=0; }
            c.setConnectTimeout(15000); c.setReadTimeout(45000); c.setInstanceFollowRedirects(false);
            String nativeCookie = EmployeeClientLoginPlugin.prepareTransportCookie(this,url,this,()->running&&e==epoch&&a.equals(account));
            if (nativeCookie == null || nativeCookie.isEmpty()) { synchronized(this){if(e!=epoch)return;terminalStatus=401;running=false;disableRestart(this);cancelAccount();event("auth",new JSONObject(),401,gen);stopForeground(true);stopSelf();}return; }
            if(streamAuthorityRejected||sessionRefreshAt==0||System.currentTimeMillis()-sessionRefreshAt>=SESSION_REFRESH_MS){
                refreshSession(url,a,e);synchronized(this){if(e==epoch)streamAuthorityRejected=false;}
            }
            if(!running||e!=epoch)return;
            nativeCookie=EmployeeClientLoginPlugin.prepareTransportCookie(this,url,this,()->running&&e==epoch&&a.equals(account));
            EmployeeClientTransportCookies.apply(c,nativeCookie); c.setRequestProperty("Accept", "text/event-stream");
            c.setRequestProperty("Origin", "https://localhost");
            synchronized(this){if(!running||e!=epoch)return;handshakeStartedAt=android.os.SystemClock.elapsedRealtime();}
            int status = c.getResponseCode();
            // A rejected stream is not proof that the durable member credential died.
            // Reconfirm through /native/session on the next backed-off attempt,
            // even with no WebView/JS listener. Only that authority may expire it.
            if(status==401){synchronized(this){if(e!=epoch)return;streamAuthorityRejected=true;}throw new Exception("stream_identity_recheck");}
            if (status == 403) {
                synchronized (this) {
                    if (e != epoch) return;
                    running = false; connected = false; terminalStatus = status;
                    event("auth", new JSONObject(), status, gen);
                    disableRestart(this);cancelAccount();stopForeground(true);stopSelf();
                }
                return;
            }
            if (status != 200 || c.getContentType() == null || !c.getContentType().contains("text/event-stream")) throw new Exception("stream_unavailable");
            try (InputStreamReader reader = new InputStreamReader(c.getInputStream(), java.nio.charset.StandardCharsets.UTF_8)) {
                StringBuilder frame = new StringBuilder(); int ch;
                while (running && e == epoch && (ch = reader.read()) != -1) {
                    frame.append((char) ch);
                    if (frame.length() > 1024 * 1024) throw new Exception("frame_too_large");
                    int n = frame.length();
                    if (n >= 2 && frame.charAt(n - 1) == '\n' && frame.charAt(n - 2) == '\n') {
                        maintainSession(url,a,e);
                        handleFrame(frame.toString(), a, gen, e); frame.setLength(0);
                    }
                }
            }
        } catch (Exception ignored) {
            // Never log URL/auth/server response. Resume from the persisted transport checkpoint.
        } finally {
            if (c != null) c.disconnect();
            synchronized (this) {
                if (e == epoch) {
                    connected = false; socket = null;
                    if (running) {
                        failures++; event("backoff", new JSONObject(), 0, gen);
                        schedule(e, Math.min(60000L, 1000L << Math.min(failures - 1, 6)));
                    }
                }
            }
        }
    }
    private synchronized void maintainSession(String base,String actor,int e) {
        if(!running||e!=epoch||sessionRefreshPending||System.currentTimeMillis()<sessionRefreshRetryAt||System.currentTimeMillis()-sessionRefreshAt<SESSION_REFRESH_MS)return;
        sessionRefreshPending=true;
        sessionWorker.execute(()->{
            try{refreshSession(base,actor,e);}catch(Exception ignored){synchronized(this){if(running&&e==epoch)sessionRefreshRetryAt=System.currentTimeMillis()+60000;}}
            finally{synchronized(this){sessionRefreshPending=false;}}
        });
    }
    private void refreshSession(String base,String actor,int e) throws Exception {
        HttpURLConnection refresh=(HttpURLConnection)new URL(new URL(base),"/native/session").openConnection();
        try (EmployeeClientRequestDeadline deadline=new EmployeeClientRequestDeadline(watchdog,refresh,30000)) {
            synchronized(this){
                if(!running||e!=epoch||!actor.equals(account))throw new Exception("session_generation_changed");
                sessionSockets.add(refresh);
            }
            refresh.setConnectTimeout(15000);refresh.setReadTimeout(15000);refresh.setInstanceFollowRedirects(false);
            String cookie=EmployeeClientLoginPlugin.prepareTransportCookie(this,base,this,()->running&&e==epoch&&actor.equals(account));
            if(cookie==null||cookie.isEmpty())throw new Exception("session_missing");
            EmployeeClientTransportCookies.apply(refresh,cookie);refresh.setRequestProperty("Accept","application/json");
            refresh.setRequestProperty("Origin","https://localhost");
            deadline.check();int code=refresh.getResponseCode();deadline.check();
            if(code==401||code==403){
                if(code==401&&EmployeeClientLoginPlugin.recoverTransportCookie(this,base,this,()->running&&e==epoch&&actor.equals(account))){synchronized(this){streamAuthorityRejected=true;}throw new Exception("restored_credential_recheck");}
                synchronized(this){if(e!=epoch)return;if(++identityRejections<2){streamAuthorityRejected=true;throw new Exception("identity_recheck_pending");}terminalStatus=code;running=false;disableRestart(this);cancelAccount();event("auth",new JSONObject(),code,generation);stopForeground(true);stopSelf();}throw new Exception("session_rejected");
            }
            if(code!=200)throw new Exception("session_refresh_unavailable");
            StringBuilder json=new StringBuilder();
            try(InputStreamReader reader=new InputStreamReader(refresh.getInputStream(),java.nio.charset.StandardCharsets.UTF_8)){
                int ch;while((ch=reader.read())!=-1){deadline.check();synchronized(this){if(!running||e!=epoch||!actor.equals(account))throw new Exception("session_generation_changed");}if(json.length()>=65536)throw new Exception("session_response_limit");json.append((char)ch);}
            }
            deadline.check();JSONObject who=new JSONObject(json.toString());
            if(!actor.equals(who.optJSONObject("identity")==null?"":who.getJSONObject("identity").optString("actor_id",""))){synchronized(this){if(e!=epoch)return;running=false;terminalStatus=401;disableRestart(this);cancelAccount();event("auth",new JSONObject(),401,generation);stopForeground(true);stopSelf();}throw new Exception("session_identity_mismatch");}
            synchronized(this){
                if(!running||e!=epoch||!actor.equals(account))return;
                deadline.check();for(java.util.Map.Entry<String,java.util.List<String>> h:refresh.getHeaderFields().entrySet())
                    if(h.getKey()!=null&&h.getKey().equalsIgnoreCase("set-cookie"))for(String value:h.getValue())CookieManager.getInstance().setCookie(base,value);
                CookieManager.getInstance().flush();identityRejections=0;sessionRefreshAt=System.currentTimeMillis();
            }
        }finally{refresh.disconnect();synchronized(this){sessionSockets.remove(refresh);}}
    }
    private synchronized void handleFrame(String frame, String a, String gen, int e) throws Exception {
        if (!running || e != epoch) return;
        String type = "", json = "";
        for (String line : frame.split("\n")) {
            if (line.startsWith("event: ")) type = line.substring(7);
            if (line.startsWith("data: ")) json = line.substring(6);
        }
        if (frame.startsWith(": heartbeat")) { if(identityVerified&&connected)lastFrame=System.currentTimeMillis();return; }
        if (type.isEmpty() || json.isEmpty()) return;
        if(!type.equals("ready")&&!type.equals("ping")&&!type.equals("change")&&!type.equals("reset")&&!type.equals("auth")&&!type.equals("error"))return;
        JSONObject data = new JSONObject(json);
        if (type.equals("ready")) {
            if (!a.equals(data.optString("actor_id", ""))) { running = false; event("auth", new JSONObject(), 401, gen);disableRestart(this);cancelAccount();stopForeground(true);stopSelf();throw new Exception("stream_identity_mismatch"); }
            identityVerified = true;
        }
        if (!identityVerified) throw new Exception("stream_identity_not_confirmed");
        if(type.equals("change")&&data.has("sync_version")&&(data.optLong("sync_version",-1)<0||data.optJSONArray("notifications")==null))throw new Exception("invalid_change_checkpoint");
        lastFrame=System.currentTimeMillis();
        if (type.equals("reset")) { prefs.edit().remove("cursor:" + a).apply(); throw new Exception("cursor_reset"); }
        if (type.equals("auth")) {
            int rejected=data.optInt("status",401);
            if(rejected==401){streamAuthorityRejected=true;throw new Exception("stream_identity_recheck");}
            terminalStatus=rejected;running=false;disableRestart(this);cancelAccount();stopForeground(true);stopSelf();
        }
        if (type.equals("ready") || type.equals("ping")) {
            connected = true; failures = 0;
        }
        if (type.equals("change")) presentNative(a, data.optJSONArray("notifications"), data.optBoolean("catchup", false), sound);
        if (type.equals("change")&&!data.isNull("sync_version")&&data.has("sync_version")) {
            if (!prefs.edit().putLong("cursor:" + a, data.getLong("sync_version")).commit()) throw new Exception("checkpoint_failed");
        }
        event(type, data, 0, gen);
    }
    private synchronized int presentNative(String a, JSONArray notes, boolean catchup, boolean audible) throws Exception {
        if (a.isEmpty() || notes == null || !NotificationManagerCompat.from(this).areNotificationsEnabled()) return 0;
        NotificationManager manager = (NotificationManager) this.getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(new NotificationChannel("employeeclient_work", "工作通知", NotificationManager.IMPORTANCE_HIGH));
            manager.createNotificationChannel(new NotificationChannel("employeeclient_work_urgent", "紧急催促", NotificationManager.IMPORTANCE_HIGH));
            NotificationChannel silent = new NotificationChannel("employeeclient_work_silent", "补取消息（静默）", NotificationManager.IMPORTANCE_LOW);
            silent.setSound(null, null); manager.createNotificationChannel(silent);
            // Sound preference must not silently disable heads-up presentation.
            NotificationChannel quietHeadsUp = new NotificationChannel("employeeclient_work_quiet_heads_up", "工作通知（无提示音）", NotificationManager.IMPORTANCE_HIGH);
            quietHeadsUp.setSound(null, null); quietHeadsUp.enableVibration(false);
            manager.createNotificationChannel(quietHeadsUp);
        }
        JSONObject log = new JSONObject(prefs.getString("shown:" + a, "{}")); int count = 0;
        long lastAlert=prefs.getLong("alert:"+a,0),lastUrgentAlert=prefs.getLong("urgent-alert:"+a,0);
        for (int i = 0; i < notes.length(); i++) {
            JSONObject n = notes.getJSONObject(i); String id = n.optString("id", "");
            long v = n.optLong("update_version", 1), now = System.currentTimeMillis();
            if (id.isEmpty()) continue;
            if (!n.isNull("read_at") || !n.isNull("acked_at") || !n.isNull("hidden_at") || n.optLong("snooze_until",0)>now) {
                manager.cancel(id, 1); log.put(id, v); continue;
            }
            if (log.optLong(id, 0) >= v) continue;
            if (!n.isNull("read_at") || !n.isNull("acked_at") || !n.isNull("hidden_at") || n.optLong("snooze_until", 0) > now || (!n.isNull("expires_at") && n.optLong("expires_at") <= now)) continue;
            boolean urgent="urgent".equals(n.optString("priority"));
            JSONObject snapshot=n.optJSONObject("snapshot");
            if (snapshot != null && snapshot.optBoolean("silent", false) && !urgent) continue;
            boolean reminder=urgent || "device_alert".equals(n.optString("kind")) || snapshot!=null && snapshot.optBoolean("reminder",false);
if ("hub_update".equals(n.optString("kind")) && snapshot!=null && "authorized_project_commit_snapshot".equals(snapshot.optString("source")) && !reminder) continue;
            if (a.equals(n.optString("actor_username")) && !reminder) continue;
            long previousAlert=urgent?lastUrgentAlert:Math.max(lastAlert,lastUrgentAlert);
            boolean headsUp = NotificationPresentation.shouldAlert(catchup, n.optLong("created_at", 0), sessionStartedAt, now)
                && NotificationPresentation.allowBurstAlert(now,previousAlert);
            if(headsUp){if(urgent)lastUrgentAlert=now;else lastAlert=now;}
            String channel = NotificationPresentation.channel(headsUp, audible, "urgent".equals(n.optString("priority")));
            Intent intent = new Intent(this, MainActivity.class).setAction("qn.notification").setData(Uri.parse("employeeclient://notification/" + Uri.encode(id)))
                .putExtra("qn_notification", n.toString()).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            PendingIntent click = PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            NotificationCompat.Builder b = new NotificationCompat.Builder(this, channel)
                .setSmallIcon(this.getApplicationInfo().icon).setContentTitle(n.optString("title", "员工客户端"))
                .setContentText(n.optString("summary", "")).setAutoCancel(true).setContentIntent(click)
                .setPriority(NotificationCompat.PRIORITY_HIGH).setGroup("qn-work");
            if (!headsUp) b.setSilent(true);
            else if (audible) b.setDefaults(android.app.Notification.DEFAULT_ALL);
            else { b.setSound(null); b.setVibrate(new long[]{0}); }
            // No setSilent(true) for quiet heads-up: it also suppresses alert presentation.
            manager.notify(id, 1, b.build()); log.put(id, v); count++;
        }
        // Cache only display receipts, not authoritative messages; bounded for this small team.
        while (log.length() > 1000) log.remove(log.keys().next());
        if (!prefs.edit().putString("shown:" + a, log.toString()).putLong("alert:"+a,lastAlert).putLong("urgent-alert:"+a,lastUrgentAlert).commit()) throw new Exception("display_checkpoint_failed");
        return count;
    }
}

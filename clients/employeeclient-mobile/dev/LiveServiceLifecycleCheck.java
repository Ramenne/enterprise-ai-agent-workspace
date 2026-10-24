package com.workspace.employeeclient;
import java.lang.reflect.*;
import java.net.*;
import java.util.*;
import java.util.concurrent.*;
/** Runs current service lifecycle methods on JVM with transport doubles; no Android device claim. */
public final class LiveServiceLifecycleCheck {
 static final class Connection extends HttpURLConnection {
  int closes;Connection()throws Exception{super(new URL("https://local.invalid"));}
  public void disconnect(){closes++;}public boolean usingProxy(){return false;}public void connect(){}
 }
 static final class Scheduler extends ScheduledThreadPoolExecutor {
  int scheduled;Scheduler(){super(1);}
  @Override public ScheduledFuture<?> schedule(Runnable work,long delay,TimeUnit unit){scheduled++;return super.schedule(()->{},1,TimeUnit.HOURS);}
 }
 static void set(Object target,String name,Object value)throws Exception{Field f;try{f=EmployeeClientLiveService.class.getDeclaredField(name);}catch(NoSuchFieldException e){if(name.equals("sessionSockets"))return;throw e;}f.setAccessible(true);f.set(target,value);}
 static Object get(Object target,String name)throws Exception{Field f=EmployeeClientLiveService.class.getDeclaredField(name);f.setAccessible(true);return f.get(target);}
 static void call(Object target,String name,Class<?>[] types,Object... args)throws Exception{Method m=EmployeeClientLiveService.class.getDeclaredMethod(name,types);m.setAccessible(true);m.invoke(target,args);}
 static void expect(boolean ok,String message){if(!ok)throw new AssertionError(message);}
 static EmployeeClientLiveService service()throws Exception{Class<?> u=Class.forName("sun.misc.Unsafe");Field f=u.getDeclaredField("theUnsafe");f.setAccessible(true);Object unsafe=f.get(null);return (EmployeeClientLiveService)u.getMethod("allocateInstance",Class.class).invoke(unsafe,EmployeeClientLiveService.class);}
 public static void main(String[] args)throws Exception{
  EmployeeClientLiveService s=service();Connection stream=new Connection(),renewal1=new Connection(),renewal2=new Connection();Set<HttpURLConnection> requests=new HashSet<>(Arrays.asList(renewal1,renewal2));set(s,"socket",stream);set(s,"sessionSockets",requests);set(s,"running",true);set(s,"connected",true);set(s,"epoch",7);
  call(s,"stopWorker",new Class<?>[0]);expect(stream.closes==1&&renewal1.closes==1&&renewal2.closes==1,"stop cancels stream and every simultaneous renewal");expect(requests.isEmpty()&&(int)get(s,"epoch")==8&&!(boolean)get(s,"running"),"stop invalidates generation and clears owned renewal connections");
  call(s,"stopWorker",new Class<?>[0]);expect(renewal1.closes==1&&renewal2.closes==1,"repeated stop does not close unrelated newer requests");
  Scheduler scheduler=new Scheduler();try{stream=new Connection();renewal1=new Connection();requests.add(renewal1);set(s,"socket",stream);set(s,"running",true);set(s,"connected",true);set(s,"lastFrame",System.currentTimeMillis());set(s,"worker",scheduler);
   call(s,"wake",new Class<?>[]{boolean.class},false);expect(stream.closes==0&&renewal1.closes==0&&scheduler.scheduled==0,"ordinary wake keeps healthy connections");
   call(s,"wake",new Class<?>[]{boolean.class},true);expect(stream.closes==1&&renewal1.closes==1&&requests.isEmpty()&&scheduler.scheduled==1,"network replacement cancels stream and renewal before rescheduling");
  }finally{scheduler.shutdownNow();}
  System.out.println("5 actual service lifecycle assertions passed with JVM transport doubles; no Android lifecycle/device execution");
 }
}

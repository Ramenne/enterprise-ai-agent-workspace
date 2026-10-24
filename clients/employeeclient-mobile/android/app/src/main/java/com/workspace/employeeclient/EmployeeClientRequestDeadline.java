package com.workspace.employeeclient;
import java.net.HttpURLConnection;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
/** A request has one total deadline, including headers and body trickle. */
final class EmployeeClientRequestDeadline implements AutoCloseable {
 private final AtomicBoolean expired=new AtomicBoolean();
 private final ScheduledFuture<?> expiry;
 EmployeeClientRequestDeadline(ScheduledExecutorService scheduler,HttpURLConnection connection,long timeoutMs){
  expiry=scheduler.schedule(()->{expired.set(true);connection.disconnect();},timeoutMs,TimeUnit.MILLISECONDS);
 }
 void check() throws TimeoutException {if(expired.get())throw new TimeoutException("request_deadline_exceeded");}
 @Override public void close(){expiry.cancel(false);}
}

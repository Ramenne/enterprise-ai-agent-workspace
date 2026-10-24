package com.workspace.employeeclient;
import java.net.CookieHandler;import java.net.HttpURLConnection;import java.util.*;
/** Match the existing automatic cookie path; never disable the global cookie handler. */
final class EmployeeClientTransportCookies {
 private static String device(String header)throws Exception{
  String value=null;if(header==null)return null;
  for(String part:header.split(";")){String item=part.trim();if(!item.startsWith("qn_member_device="))continue;
   String next=item.substring("qn_member_device=".length());if(!next.matches("[A-Za-z0-9_-]{20,4096}"))throw new Exception("invalid_device_cookie");
   if(value!=null&&!value.equals(next))throw new Exception("conflicting_device_cookie");value=next;
  }return value;
 }
 static void apply(HttpURLConnection connection,String cookie)throws Exception{
  String expected=device(cookie);CookieHandler handler=CookieHandler.getDefault();
  if(handler!=null){Map<String,List<String>> headers=handler.get(connection.getURL().toURI(),Collections.emptyMap());StringBuilder automatic=new StringBuilder();
   for(Map.Entry<String,List<String>> h:headers.entrySet())if("Cookie".equalsIgnoreCase(h.getKey()))for(String value:h.getValue()){if(automatic.length()>0)automatic.append("; ");automatic.append(value);}
   String supplied=device(automatic.toString());
   if(expected!=null&&supplied!=null){if(!expected.equals(supplied))throw new Exception("transport_identity_changed");return;}
   if(expected==null&&automatic.toString().equals(cookie))return;
  }
  if(cookie!=null&&!cookie.isEmpty())connection.setRequestProperty("Cookie",expected==null?cookie:"qn_member_device="+expected);
 }
}

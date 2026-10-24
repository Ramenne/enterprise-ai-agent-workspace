package com.workspace.employeeclient;
public class UpdateDownloadSourceTest {
 public static void main(String[] args) throws Exception {
  String old="https://employeeclient.example.invalid/updates/android/employeeclient-v148.apk";
  String direct="https://employeeclient-download.example.invalid/public/employeeclient/releases/android/148/employeeclient-v148.apk";
  if(!UpdateDownloadSource.select(old,null,148).equals(old)||!UpdateDownloadSource.select(old,direct,148).equals(direct))throw new AssertionError();
  for(String bad:new String[]{"",direct+"?x=1",direct+"#x",direct.replace("https:","http:"),direct.replace("/148/","/146/"),direct.replace(".cloud/",".cloud:443/"),direct.replace("service.example.invalid","service.example.invalid.evil.invalid"),direct.replace("https://","https://u:p@"),direct.replace("/public/","/private/")}){
   try{UpdateDownloadSource.select(old,bad,148);throw new AssertionError(bad);}catch(Exception expected){if(!"update_source_invalid".equals(expected.getMessage()))throw expected;}
  }
  for(String bad:new String[]{old+"?x=1",old.replace("https:","http:"),old.replace(".cloud/",".cloud.evil.invalid/"),old.replace("/updates/","/other/")}){
   try{UpdateDownloadSource.select(bad,direct,148);throw new AssertionError(bad);}catch(Exception expected){if(!"update_source_invalid".equals(expected.getMessage()))throw expected;}
  }
  System.out.println("Android download source policy: old channel, exact COS object, URL rejection passed");
 }
}

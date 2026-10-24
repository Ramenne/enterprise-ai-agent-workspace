package com.workspace.employeeclient;
public final class LiveConnectionPolicyCheck {
    static void expect(boolean actual,boolean expected,String scenario) { if(actual!=expected)throw new AssertionError(scenario); }
    public static void main(String[] args) {
        expect(LiveConnectionPolicy.shouldRebuild(true,100001,100000,false),false,"ordinary foreground wake preserves a healthy socket");
        expect(LiveConnectionPolicy.shouldRebuild(true,100001,100000,true),true,"new network replaces a recently active socket");
        expect(LiveConnectionPolicy.shouldRebuild(true,100001,100000,true),true,"network loss invalidates the old socket");
        expect(LiveConnectionPolicy.shouldRebuild(false,100001,100000,false),true,"disconnected foreground wake rebuilds");
        expect(LiveConnectionPolicy.shouldRebuild(true,145000,100000,false),true,"silent socket deadline rebuilds");
        expect(LiveConnectionPolicy.shouldRebuild(true,90000,100000,false),true,"wall clock rollback cannot preserve stale socket forever");
        System.out.println("6 native reconnect policy scenarios passed; Android service/device execution not asserted");
    }
}

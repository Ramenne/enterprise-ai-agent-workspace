package com.workspace.employeeclient;
public class AttachmentIntegerCheck {
    private static void check(Object value, long expected) {
        if (AttachmentInteger.read(value, -1) != expected) throw new AssertionError(String.valueOf(value));
    }
    public static void main(String[] args) {
        check(Integer.valueOf(0), 0); check(Integer.valueOf(95), 95); check(Integer.valueOf(23500), 23500);
        check(Long.valueOf(107374182400L), 107374182400L); check(Double.valueOf(524288), 524288);
        check(null, -1); check("23500", -1); check(Double.NaN, -1); check(1.5d, -1); check(9007199254740992d, -1);
        System.out.println("10 bridge integer cases passed: zero offsets, small files, large files and invalid inputs");
    }
}

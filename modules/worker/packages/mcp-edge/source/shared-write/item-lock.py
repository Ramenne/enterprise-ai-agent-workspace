import os, sys, stat, fcntl
os.umask(0o077)
fd=os.open(sys.argv[1],os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
try:
    s=os.fstat(fd)
    if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.getuid() or stat.S_IMODE(s.st_mode)!=0o600: sys.exit(2)
    try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError: sys.exit(3)
    print('locked',flush=True)
    sys.stdin.buffer.read() # Parent exit/normal finally releases real OS lock.
finally:
    os.close(fd)

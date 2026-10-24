"""Writer half of hub2-area-checkpoint-fence.v1; identical A1 lock path and flock protocol."""
import contextlib,fcntl,hashlib,json,os,stat,time

class BarrierRejected(Exception):
    pass

def lock_name(area_id):
    return hashlib.sha256(json.dumps(['recovery-area',area_id],sort_keys=True,separators=(',',':')).encode()).hexdigest()+'.checkpoint.lock'

def _directory(path):
    if not isinstance(path,str) or not path.startswith('/') or os.path.normpath(path)!=path:
        raise BarrierRejected('invalid_checkpoint_journal')
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
    try:
        for component in path.split('/')[1:]:
            child=os.open(component,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            os.close(fd);fd=child
        return fd
    except BaseException:os.close(fd);raise

def _identity(info):return info.st_dev,info.st_ino

@contextlib.contextmanager
def shared_area(journal,area_id,journal_identity,wait_seconds=5):
    """Acquire before current authority. Keep through all effects and durable journal receipts."""
    directory=_directory(str(journal));fd=None
    try:
        info=os.fstat(directory)
        if info.st_uid!=os.geteuid() or info.st_mode&0o022 or _identity(info)!=journal_identity:
            raise BarrierRejected('checkpoint_journal_binding_changed')
        name=lock_name(area_id)
        fd=os.open(name,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600,dir_fd=directory)
        def validate():
            current=os.fstat(fd);entry=os.stat(name,dir_fd=directory,follow_symlinks=False)
            if not stat.S_ISREG(current.st_mode) or current.st_uid!=os.geteuid() or current.st_nlink!=1 or current.st_mode&0o077 or current.st_size!=0:
                raise BarrierRejected('checkpoint_lock_integrity')
            if _identity(entry)!=_identity(current):raise BarrierRejected('checkpoint_lock_replaced')
            check=_directory(str(journal))
            try:
                if _identity(os.fstat(check))!=journal_identity:raise BarrierRejected('checkpoint_journal_binding_changed')
            finally:os.close(check)
            return current
        validate();deadline=time.monotonic()+wait_seconds
        while True:
            try:fcntl.flock(fd,fcntl.LOCK_SH|fcntl.LOCK_NB);break
            except BlockingIOError:
                if time.monotonic()>=deadline:raise BarrierRejected('checkpoint_wait_timeout')
                time.sleep(min(.02,max(0,deadline-time.monotonic())))
        current=validate()
        yield {'area_id':area_id,'lock_device':current.st_dev,'lock_inode':current.st_ino,'mode':'shared'}
        # Root restoration must quiesce routes. Detect accidental unlink/rebind;
        # advisory locks cannot defend against a privileged host administrator.
        validate()
    finally:
        if fd is not None:os.close(fd)
        os.close(directory)

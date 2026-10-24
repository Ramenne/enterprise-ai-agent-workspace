"""Fixed platform SQLite online backup; runs only as EmployeeClient's own UID."""
import datetime,fcntl,hashlib,json,os,pathlib,sqlite3,tempfile
BASE=pathlib.Path('/srv/workspace')
DB=BASE/'business.db'; OUT=BASE/'backups/platform-daily'; LIMIT=512*1024*1024
if os.geteuid()!=899:raise RuntimeError('employeeclient_uid_required')
if DB.is_symlink() or DB.stat().st_uid!=899 or OUT.is_symlink():raise RuntimeError('unsafe_backup_path')
OUT.mkdir(mode=0o700,parents=True,exist_ok=True);os.chmod(OUT,0o700)
lock=os.open(OUT/'.backup.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
fcntl.flock(lock,fcntl.LOCK_EX)
now=datetime.datetime.now(datetime.timezone.utc);name='business-'+now.strftime('%Y%m%dT%H%M%SZ')+'.sqlite'
fd,tmp=tempfile.mkstemp(prefix='.pending-',dir=OUT);os.close(fd)
try:
 with sqlite3.connect('file:'+str(DB)+'?mode=ro',uri=True,timeout=30) as source,sqlite3.connect(tmp) as target:
  source.backup(target,pages=256,sleep=.05)
  if target.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise RuntimeError('backup_integrity_failed')
 size=os.stat(tmp).st_size
 if size>LIMIT:raise RuntimeError('backup_exceeds_reserved_capacity')
 with open(tmp,'rb') as f:os.fsync(f.fileno())
 os.replace(tmp,OUT/name)
 snapshots=sorted(OUT.glob('business-*.sqlite'),key=lambda p:p.name)
 cutoff=now.timestamp()-7*86400
 for p in snapshots[:-1]:
  if not p.is_symlink() and p.stat().st_mtime<cutoff:p.unlink()
 snapshots=sorted(OUT.glob('business-*.sqlite'),key=lambda p:p.name)
 total=sum(p.stat().st_size for p in snapshots if not p.is_symlink())
 for p in snapshots[:-1]:
  if total<=LIMIT:break
  if not p.is_symlink():total-=p.stat().st_size;p.unlink()
 digest=hashlib.sha256((OUT/name).read_bytes()).hexdigest()
 result={'state':'completed','backup_file':str(OUT/name),'bytes':size,'sha256':digest,'quick_check':'ok','uid':899,'retention_days':7,'space_budget_bytes':LIMIT,'prune_policy':'age_7_days_then_capacity;always_keep_latest','restore':'stop_application_then_SQLite_backup_API_to_business.db;never_copy_over_live_WAL_database'}
 (OUT/'last-receipt.json').write_text(json.dumps(result));os.chmod(OUT/'last-receipt.json',0o600)
 print(json.dumps(result))
finally:
 if os.path.exists(tmp):os.unlink(tmp)
 os.close(lock)

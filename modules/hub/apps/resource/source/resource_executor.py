"""Original Hub2 360 constrained executor; no shell/SQL/cloud master credential surface."""
import datetime
import subprocess, tempfile, signal
import base64, contextlib, fcntl, hashlib, json, os, re, sqlite3, stat, time, urllib.error, urllib.request, uuid
from pathlib import Path
from resource_barrier import shared_area, BarrierRejected

class Rejected(Exception):
    def __init__(self, code, status=403, receipt=None):
        self.code, self.status, self.receipt = code, status, receipt
        super().__init__(code)

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()

def sha(data):
    return hashlib.sha256(data).hexdigest()

def root_fingerprint(root):
    info=os.stat(root,follow_symlinks=False)
    return sha(canonical({'root':root,'device':info.st_dev,'inode':info.st_ino}))

def parts(path):
    if not isinstance(path, str) or len(path.encode()) > 4096 or '\x00' in path:
        raise Rejected('invalid_path', 400)
    value = path.split('/')
    if any(p in ('', '.', '..') or p.startswith('.hub2-') for p in value) or path.startswith('/'):
        raise Rejected('invalid_path', 400)
    return value

class OnlineAuthority:
    """Machine service key only permits current checks, never grants member rights."""
    def __init__(self, url, service_key, endpoint_id):
        if not url.startswith('https://') and not url.startswith('http://127.0.0.1:'):
            raise ValueError('TLS or loopback required')
        self.url, self.service_key, self.endpoint_id = url, service_key, endpoint_id
    def __call__(self, bearer, request, request_hash, phase):
        body = {k: request[k] for k in ('project_id', 'area_id', 'operation', 'environment') if k in request}
        body.update(endpoint_id=self.endpoint_id, request_hash=request_hash, phase=phase)
        call = urllib.request.Request(self.url, canonical(body), method='POST', headers={
            'Authorization': 'Bearer ' + bearer, 'X-Hub-Service-Key': self.service_key,
            'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(call, timeout=5) as response:
                result = json.loads(response.read(65537))
        except urllib.error.HTTPError as error:
            raise Rejected('authority_rejected', 401 if error.code == 401 else 403 if error.code == 403 else 503) from None
        except (OSError, ValueError):
            raise Rejected('authority_unavailable', 503) from None
        if result.get('request_hash') != request_hash or result.get('endpoint_id') != self.endpoint_id or result.get('phase') != phase:
            raise Rejected('authority_binding_mismatch', 503)
        return result

class Executor:
    OPERATIONS = {'read': 'resource.read', 'write': 'resource.write', 'deploy': 'resource.deploy'}
    def __init__(self, areas, journal, authority):
        self.authority, self.areas = authority, {}
        self.journal = Path(journal)
        self.journal.mkdir(mode=0o700, parents=True, exist_ok=True)
        journalfd = self._absolute(str(self.journal))
        self._trusted(os.fstat(journalfd)); self._journal_identity=(os.fstat(journalfd).st_dev,os.fstat(journalfd).st_ino); os.close(journalfd)
        self.db = sqlite3.connect(self.journal / 'operations.sqlite', isolation_level=None)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('CREATE TABLE IF NOT EXISTS operations (actor TEXT, client TEXT, idem TEXT, request_hash TEXT, state TEXT, staged TEXT, dev INTEGER, ino INTEGER, receipt TEXT, PRIMARY KEY(actor, client, idem))')
        self.db.execute('CREATE TABLE IF NOT EXISTS directories (actor TEXT, client TEXT, idem TEXT, path TEXT, request_hash TEXT, staged TEXT, dev INTEGER, ino INTEGER, state TEXT, PRIMARY KEY(actor,client,idem,path))')
        try:self._register_areas(areas)
        except BaseException:self.close();raise
    def _register_areas(self,areas):
        for aid, spec in areas.items():
            root = spec['root']
            if os.path.commonpath([root,str(self.journal)]) in (root,str(self.journal)):
                raise ValueError('journal_and_registered_roots_must_be_disjoint')
            fd = self._absolute(root)
            try:
                identity = os.fstat(fd)
                self._trusted(identity)
                if spec.get('root_fingerprint') != root_fingerprint(root):raise Rejected('root_fingerprint_mismatch')
                if any(os.path.commonpath([root, v['root']]) in (root, v['root']) for v in self.areas.values()):raise ValueError('overlapping area roots')
                self.areas[aid] = dict(spec, fd=fd, identity=(identity.st_dev, identity.st_ino))
            finally:
                if aid not in self.areas:os.close(fd)
    @staticmethod
    def _trusted(info):
        if info.st_uid != os.geteuid() or info.st_mode & 0o022:
            raise Rejected('unsafe_directory_owner_or_mode')
    @staticmethod
    def _absolute(root):
        if not isinstance(root, str) or not root.startswith('/') or os.path.normpath(root) != root:
            raise ValueError('canonical absolute area root required')
        fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
        try:
            for component in root.split('/')[1:]:
                new = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd); fd = new
            return fd
        except BaseException:
            os.close(fd); raise
    @contextlib.contextmanager
    def parent(self, area, path):
        names = parts(path); fd = os.dup(area['fd'])
        try:
            for component in names[:-1]:
                new = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                self._trusted(os.fstat(new))
                os.close(fd); fd = new
            yield fd, names[-1]
        finally:
            os.close(fd)
    @staticmethod
    def read_fd(parent, name, limit=2*1024*1024):
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid():
                raise Rejected('unsafe_file_type_or_hardlink')
            data = bytearray()
            while len(data) <= limit:
                chunk = os.read(fd, min(65536, limit + 1 - len(data)))
                if not chunk: break
                data.extend(chunk)
            if len(data) > limit: raise Rejected('file_limit', 413)
            return bytes(data), info
        finally: os.close(fd)
    def _parents(self, bearer, request, digest, identity, area, key):
        """Create only missing descendants of a pinned registered root, with durable inode recovery."""
        hierarchy=self.journal/(sha(canonical(['directories',request['area_id']]))+'.dirs.lock')
        with hierarchy.open('a+b') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX)
            fd=os.dup(area['fd']);relative=[]
            try:
                for component in parts(request['path'])[:-1]:
                    relative.append(component);path='/'.join(relative)
                    row=self.db.execute('SELECT request_hash,staged,dev,ino,state FROM directories WHERE actor=? AND client=? AND idem=? AND path=?',(*key,path)).fetchone()
                    if row and row[0]!=digest:raise Rejected('idempotency_conflict',409)
                    try:
                        child=os.open(component,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
                    except FileNotFoundError:
                        if row and row[4]=='complete':raise Rejected('directory_recovery_mismatch',409)
                        staged=row[1] if row else '.hub2-dir-'+uuid.uuid4().hex
                        try: child=os.open(staged,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
                        except FileNotFoundError:
                            os.mkdir(staged,0o700,dir_fd=fd);os.fsync(fd)
                            child=os.open(staged,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
                        try:
                            si=os.fstat(child);self._trusted(si)
                            if row and (si.st_dev,si.st_ino)!=(row[2],row[3]):raise Rejected('directory_recovery_mismatch',409)
                            self.db.execute('INSERT INTO directories VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(actor,client,idem,path) DO UPDATE SET staged=excluded.staged,dev=excluded.dev,ino=excluded.ino,state=excluded.state',(*key,path,digest,staged,si.st_dev,si.st_ino,'prepared'))
                            permit=time.monotonic();self._check(bearer,request,digest,'effect',area,identity)
                            # Existing prefix must still resolve to this exact parent.
                            with self.parent(area,path) as (nowfd,_):
                                if (os.fstat(nowfd).st_dev,os.fstat(nowfd).st_ino)!=(os.fstat(fd).st_dev,os.fstat(fd).st_ino):raise Rejected('parent_directory_changed')
                            if time.monotonic()-permit>2:raise Rejected('authority_window_expired',503)
                            os.rename(staged,component,src_dir_fd=fd,dst_dir_fd=fd);os.fsync(fd)
                            self.db.execute('UPDATE directories SET state=?,staged=NULL WHERE actor=? AND client=? AND idem=? AND path=?',('complete',*key,path))
                        except BaseException:os.close(child);raise
                    si=os.fstat(child)
                    try:
                        self._trusted(si)
                        if row and (si.st_dev,si.st_ino)!=(row[2],row[3]):raise Rejected('directory_recovery_mismatch',409)
                        if row:self.db.execute('UPDATE directories SET state=?,staged=NULL WHERE actor=? AND client=? AND idem=? AND path=?',('complete',*key,path))
                    except BaseException:os.close(child);raise
                    os.close(fd);fd=child
            finally:os.close(fd)
    def _check(self, bearer, request, digest, phase, area, previous=None):
        started = time.monotonic()
        current = self.authority(bearer, request, digest, phase)
        if time.monotonic() - started > 2:
            raise Rejected('authority_window_expired', 503)
        if current.get('deadline') and datetime.datetime.fromisoformat(current['deadline'].replace('Z','+00:00')).timestamp() <= time.time():
            raise Rejected('authority_window_expired', 503)
        if current.get('action') != self.OPERATIONS[request['operation']] or current.get('project_id') != request['project_id'] or current.get('area_id') != request['area_id'] or current.get('area_epoch') != area['epoch'] or current.get('environment') != area.get('environment', 'none'):
            raise Rejected('authority_or_target_binding_mismatch')
        if any(current.get(k) != area.get(k) for k in ('target_epoch','endpoint_epoch','root_fingerprint')):
            raise Rejected('target_configuration_changed')
        if not all(isinstance(current.get(k), str) and current[k] for k in ('actor_id', 'client_id', 'credential_id')):
            raise Rejected('identity_required')
        if previous and any(current[k] != previous[k] for k in ('actor_id', 'client_id', 'credential_id')):
            raise Rejected('identity_changed')
        fd = self._absolute(area['root'])
        try:
            self._trusted(os.fstat(fd))
            if (os.fstat(fd).st_dev, os.fstat(fd).st_ino) != area['identity']:
                raise Rejected('area_root_changed')
        finally: os.close(fd)
        return current
    def execute(self, bearer, request, crash_after_effect=False):
        if not isinstance(request,dict) or request.get('operation') not in ('write','deploy') or request.get('area_id') not in self.areas:
            return self._execute(bearer,request,crash_after_effect)
        try:
            with shared_area(self.journal,request['area_id'],self._journal_identity):
                return self._execute(bearer,request,crash_after_effect)
        except BarrierRejected as error:
            raise Rejected(str(error),503) from None
    def _execute(self, bearer, request, crash_after_effect=False):
        allowed = {'operation', 'project_id', 'area_id', 'path', 'data_b64', 'sha256', 'expected_sha256', 'idempotency_key', 'environment', 'create_parents'}
        if not isinstance(request, dict) or set(request) - allowed or request.get('operation') not in self.OPERATIONS:
            raise Rejected('invalid_operation', 400)
        if 'create_parents' in request and (request['operation']!='write' or not isinstance(request['create_parents'],bool)):
            raise Rejected('invalid_parent_creation',400)
        area = self.areas.get(request.get('area_id'))
        if not area or area['project_id'] != request.get('project_id'):
            raise Rejected('unknown_or_cross_project_area')
        if request.get('environment', 'none') != area.get('environment', 'none'):
            raise Rejected('environment_mismatch')
        if request['operation'] == 'deploy':
            if not re.fullmatch('[0-9a-f]{64}', str(request.get('sha256', ''))) or 'path' in request or area.get('environment', 'none') == 'none':
                raise Rejected('invalid_deployment', 400)
            path = request['sha256'] + '.artifact'
        else:
            path = request.get('path'); parts(path)
        digest = sha(canonical(request))
        identity = self._check(bearer, request, digest, 'start', area)
        if request['operation'] == 'read':
            with self.parent(area, path) as (fd, name):
                data, _ = self.read_fd(fd, name)
                self._check(bearer, request, digest, 'effect', area, identity)
            return dict(state='read', actor_id=identity['actor_id'], client_id=identity['client_id'], area_id=request['area_id'], sha256=sha(data), data_b64=base64.b64encode(data).decode())
        idem = request.get('idempotency_key')
        if not isinstance(idem, str) or not 1 <= len(idem) <= 200:
            raise Rejected('idempotency_required', 400)
        try: data = base64.b64decode(request.get('data_b64', ''), validate=True)
        except (ValueError, TypeError): raise Rejected('invalid_content', 400) from None
        if len(data) > 2*1024*1024: raise Rejected('file_limit', 413)
        content_hash = sha(data)
        if content_hash != request.get('sha256'):
            raise Rejected('fixed_content_mismatch', 409)
        key = identity['actor_id'], identity['client_id'], idem
        # Per-target serialization prevents CAS races without locking unrelated files.
        lock = self.journal / (sha(canonical([request['area_id'], '__registered_deployment__' if request['operation']=='deploy' else path])) + '.lock')
        idem_lock = self.journal / (sha(canonical(key)) + '.idem.lock')
        with idem_lock.open('a+b') as idemfile, lock.open('a+b') as lockfile:
            fcntl.flock(idemfile, fcntl.LOCK_EX)
            fcntl.flock(lockfile, fcntl.LOCK_EX)
            row = self.db.execute('SELECT request_hash,state,staged,dev,ino,receipt FROM operations WHERE actor=? AND client=? AND idem=?', key).fetchone()
            if row and row[0] != digest: raise Rejected('idempotency_conflict', 409)
            if row and row[1] == 'complete':
                return json.loads(row[5])
            if request.get('create_parents'):
                self._parents(bearer,request,digest,identity,area,key)
            with self.parent(area, path) as (fd, name):
                existing, info = None, None
                try: existing, info = self.read_fd(fd, name)
                except FileNotFoundError: pass
                if row and info and (info.st_dev, info.st_ino) == (row[3], row[4]) and sha(existing) == content_hash:
                    self._check(bearer, request, digest, 'effect', area, identity)
                    return self._finish(key, identity, request, digest, path, content_hash, True, bearer, area)
                expected = request.get('expected_sha256')
                if expected is not None and expected != (sha(existing) if existing is not None else 'absent'):
                    raise Rejected('file_version_conflict', 409)
                if request['operation'] == 'deploy' and existing is not None:
                    if sha(existing) != content_hash: raise Rejected('artifact_corrupt', 409)
                    self._check(bearer, request, digest, 'effect', area, identity)
                    return self._finish(key, identity, request, digest, path, content_hash, True, bearer, area)
                staged = '.hub2-' + uuid.uuid4().hex
                stagefd = os.open(staged, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
                try:
                    with os.fdopen(stagefd, 'wb') as file:
                        file.write(data); file.flush(); os.fsync(file.fileno()); si = os.fstat(file.fileno())
                    if row and row[2]:
                        try: os.unlink(row[2], dir_fd=fd)
                        except FileNotFoundError: pass
                    self.db.execute('INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(actor,client,idem) DO UPDATE SET state=excluded.state,staged=excluded.staged,dev=excluded.dev,ino=excluded.ino', (*key,digest,'prepared',staged,si.st_dev,si.st_ino,None))
                    permit_at = time.monotonic()
                    self._check(bearer, request, digest, 'effect', area, identity)
                    # Verify the parent has not been replaced between traversal and publication.
                    with self.parent(area, path) as (nowfd, _):
                        if (os.fstat(nowfd).st_dev, os.fstat(nowfd).st_ino) != (os.fstat(fd).st_dev, os.fstat(fd).st_ino):
                            raise Rejected('parent_directory_changed')
                    if time.monotonic() - permit_at > 2: raise Rejected('authority_window_expired', 503)
                    os.replace(staged, name, src_dir_fd=fd, dst_dir_fd=fd); os.fsync(fd)
                    if crash_after_effect: raise RuntimeError('synthetic crash after effect before receipt')
                    return self._finish(key, identity, request, digest, path, content_hash, False, bearer, area)
                except BaseException:
                    try: os.unlink(staged, dir_fd=fd)
                    except FileNotFoundError: pass
                    raise
    def _finish(self, key, identity, request, digest, path, content_hash, recovered, bearer, area):
        receipt = dict(state='delivered', operation_id=sha(canonical(key)), request_hash=digest,
                       actor_id=identity['actor_id'], client_id=identity['client_id'], credential_id=identity['credential_id'],
                       project_id=request['project_id'], area_id=request['area_id'], area_epoch=identity['area_epoch'],
                       environment=request.get('environment','none'), path=path, sha256=content_hash,
                       operation=request['operation'], recovered=recovered, executed_at=time.time(),
                       deployment_effect='immutable_artifact_delivery' if request['operation']=='deploy' else 'atomic_file_replace')
        if request['operation'] == 'deploy':
            receipt['state'] = 'staged'
            receipt['delivered_at'] = receipt.pop('executed_at')
            if area.get('runner'):
                runner = area['runner']
                if not runner.get('idempotent') or not isinstance(runner.get('argv'),list) or not runner['argv'] or any(not isinstance(a,str) for a in runner['argv']):
                    raise Rejected('unsafe_runner_configuration',503)
                executable=runner['argv'][0]
                if not os.path.isabs(executable): raise Rejected('unsafe_runner_configuration',503)
                st=os.stat(executable,follow_symlinks=False)
                if not stat.S_ISREG(st.st_mode) or st.st_uid not in (0,os.geteuid()) or st.st_mode & 0o022:
                    raise Rejected('unsafe_runner_configuration',503)
                self.db.execute('UPDATE operations SET receipt=? WHERE actor=? AND client=? AND idem=?',(json.dumps(receipt),*key))
                try: permit=self._check(bearer,request,digest,'effect',area,identity)
                except Rejected as error:
                    error.receipt=receipt;raise
                env={'PATH':'/usr/bin:/bin','HUB2_ARTIFACT_PATH':area['root']+'/'+path,'HUB2_ARTIFACT_HASH':content_hash,'HUB2_OPERATION_ID':receipt['operation_id'],'HUB2_ENVIRONMENT':receipt['environment'],'HUB2_AUTHORITY_DEADLINE':permit.get('deadline','')}
                with tempfile.TemporaryFile(dir=self.journal) as stdout, tempfile.TemporaryFile(dir=self.journal) as stderr:
                    try:
                        done=subprocess.Popen(runner['argv'],env=env,stdin=subprocess.DEVNULL,stdout=stdout,stderr=stderr,shell=False,start_new_session=True)
                        try:done.wait(timeout=runner.get('timeout_seconds',10))
                        except subprocess.TimeoutExpired:
                            os.killpg(done.pid,signal.SIGKILL);done.wait();raise
                        stdout.seek(0);result=json.loads(stdout.read(65537))
                    except (OSError,ValueError,subprocess.TimeoutExpired):
                        raise Rejected('runner_failed_or_uncertain',503,receipt) from None
                if done.returncode or result.get('state')!='executed' or result.get('sha256')!=content_hash or result.get('operation_id')!=receipt['operation_id'] or result.get('environment')!=receipt['environment']:
                    raise Rejected('runner_failed_or_uncertain',503,receipt)
                receipt.update(state='executed',executed_at=time.time(),deployment_effect='registered_runner_applied_fixed_artifact',runner_id=runner['id'],runner_receipt=result)
        self.db.execute('INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(actor,client,idem) DO UPDATE SET state=excluded.state,receipt=excluded.receipt', (*key,digest,'complete',None,None,None,json.dumps(receipt)))
        return receipt
    def close(self):
        self.db.close()
        for area in self.areas.values(): os.close(area['fd'])

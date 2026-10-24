#!/usr/bin/env python3
"""Root installer of fixed control metadata and ORIGINAL source seed. No legacy edit.
Run on xiaochen with this source directory deployed; no arbitrary member module import.
"""
from pathlib import Path
import shutil,json,os,sys
from application_release import PROFILES,ROOT,SHARED
source=Path(sys.argv[1]).resolve() if len(sys.argv)>1 else Path(__file__).resolve().parent
if not (source/'shared').is_dir() or any(not (source/p['slug']/'src').is_dir() for p in PROFILES.values()):raise ValueError('original_bootstrap_source_bundle_required')
shared_version=ROOT/'shared'/'initial-original-20261006';shared_version.mkdir(parents=True,exist_ok=True)
for f in (source/'shared').glob('*.py'):shutil.copyfile(f,shared_version/f.name);os.chmod(shared_version/f.name,0o644)
SHARED.parent.mkdir(parents=True,exist_ok=True)
if not SHARED.exists():SHARED.symlink_to(shared_version)
for pid,p in PROFILES.items():
 base=ROOT/p['slug'];seed=base/'initial-original-20261006';seed.mkdir(parents=True,exist_ok=True)
 for f in (source/p['slug']/'src').glob('*.py'):shutil.copyfile(f,seed/f.name);os.chmod(seed/f.name,0o644)
 (seed/'manifest.json').write_text(json.dumps({'project_id':pid,'source':'actual running original2.0 adapter seed;not member build','commit':None}))
 current=base/'current'
 if not current.exists():current.symlink_to(seed)
 for i,unit in enumerate(p['services']):
  drop=Path('/etc/systemd/system')/(unit+'.d');drop.mkdir(exist_ok=True)
  path=str(SHARED)+':'+str(current)+':'+p['legacy']
  launch=p.get('launch') or [p['python'],str(current/p['entry']),*(['--ws'] if i else [])]
  (drop/'30-engineering-release.conf').write_text('[Service]\nEnvironment=PYTHONPATH='+path+'\nExecStart=\nExecStart='+' '.join(launch)+'\n')
print(json.dumps({'state':'installed','services':[s for p in PROFILES.values() for s in p['services']],'action':'daemon-reload then only original hufu2 compat restarts coordinated separately'}))

"""Verify a supplied directory or ZIP; execute fixture tests only with --node."""
import argparse
import hashlib
import json
import subprocess
import tempfile
import zipfile
from pathlib import Path, PurePosixPath


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('packet', type=Path)
    parser.add_argument('--node')
    args = parser.parse_args()
    packet = args.packet.resolve()
    if packet.is_file():
        with zipfile.ZipFile(packet) as bundle:
            names = [x.filename for x in bundle.infolist() if not x.is_dir()]
            if len(names) != len(set(names)):
                raise ValueError('duplicate archive entries')
            files = {name: bundle.read(name) for name in names}
    else:
        paths = [p for p in packet.rglob('*') if p.is_file()]
        if any(p.is_symlink() for p in packet.rglob('*')):
            raise ValueError('symlinks are not part of the packet')
        files = {p.relative_to(packet).as_posix(): p.read_bytes() for p in paths}
    for name in files:
        p = PurePosixPath(name)
        if p.is_absolute() or '..' in p.parts or '\\' in name or str(p) != name:
            raise ValueError('unsafe packet path')
    manifest = json.loads(files['manifest.json'])
    expected = manifest['files']
    if set(files) != set(expected) | {'manifest.json'}:
        raise ValueError('packet file set differs from manifest')
    for name, record in expected.items():
        if len(files[name]) != record['bytes'] or hashlib.sha256(files[name]).hexdigest() != record['sha256']:
            raise ValueError('integrity mismatch: ' + name)
    result = {'integrity': 'passed', 'files': len(expected), 'fixtureTests': 'not_run', 'centralDeployed': False}
    if args.node:
        with tempfile.TemporaryDirectory(prefix='tools-central-mcp-check-') as temporary:
            base = Path(temporary)
            for name in ['adapter.mjs', 'adapter.test.mjs', 'host-hooks.mjs', 'host-hooks.test.mjs']:
                (base / name).write_bytes(files['central-adapter/' + name])
            run = subprocess.run([args.node, '--test', 'adapter.test.mjs', 'host-hooks.test.mjs'], cwd=base, capture_output=True, text=True, timeout=60)
            if run.returncode:
                raise RuntimeError('fixture tests failed\n' + run.stdout + run.stderr)
            result['fixtureTests'] = 'passed'
            result['testOutput'] = run.stdout
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()

"""Build an explicit source/evidence handoff; no credentials or local state."""
import hashlib
import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
node = sys.argv[1]
revision = sys.argv[2] if len(sys.argv) > 2 else 'v1'
if not revision.startswith('v') or not revision[1:].isdigit():
    raise SystemExit('Revision must be v followed by digits.')
suffix = '' if revision == 'v1' else '-' + revision
packet = root / ('handoff/central-mcp-20261021' + suffix)
archive = root / ('dist/tools-central-mcp-handoff-20261021' + suffix + '.zip')
if packet.exists() or archive.exists():
    raise SystemExit('Use a new delivery revision; existing packet is retained.')
reference = root / 'dist/workspace-tools-mcp-1.0.0.zip'
if hashlib.sha256(reference.read_bytes()).hexdigest() != '2a875c6f7cbb42a936d53056a27261cab5ca7cb32f190164a134372594a6338d':
    raise SystemExit('Independent connector release differs from recorded release.')
run = subprocess.run([node, '--test', 'adapter.test.mjs', 'host-hooks.test.mjs'], cwd=root / 'central-mcp', capture_output=True, text=True, timeout=60, check=True)
copies = {
    '00-交接说明.txt': root / 'central-mcp/DEPLOYMENT.txt',
    '01-当前中枢入口补记.txt': root / 'central-mcp/CURRENT-CENTRAL.txt',
    'verify-package.py': root / 'central-mcp/verify-package.py',
    'contracts/TOOLS-API.md': root / 'README.md',
    'reference/workspace-tools-mcp-1.0.0.zip': reference,
    'evidence/independent-mcp-verification-20261020.json': root / 'evidence/tools-mcp-verification.json',
}
for name in ['adapter.mjs', 'adapter.test.mjs', 'host-hooks.mjs', 'host-hooks.test.mjs', 'integration.json']:
    copies['central-adapter/' + name] = root / 'central-mcp' / name
packet.mkdir(parents=True)
for name, source in copies.items():
    target = packet / name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)
(packet / 'evidence/central-adapter-tests.json').write_text(json.dumps({'date':'2026-10-21','state':'passed','tests':13,'synthetic':True,'centralDeployed':False,'output':run.stdout}, ensure_ascii=False, indent=2) + '\n')
files = {p.relative_to(packet).as_posix(): {'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(packet.rglob('*')) if p.is_file()}
manifest = {'schema':1,'work_no':1000347,'date':'2026-10-21','deployment_owner':'central_team','state':'handoff_prepared_not_deployed','files':files,'upstream_dependencies':'TOOLS HTTPS API and actual central authenticated dispatcher; no credentials included','source_coverage':'Selected existing TOOLS connector and adapter artifacts, not complete central MCP source or full conversation export.'}
(packet / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
archive.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(archive, 'x', zipfile.ZIP_DEFLATED) as bundle:
    for p in sorted(packet.rglob('*')):
        if p.is_file():
            bundle.write(p, p.relative_to(packet).as_posix())
proof = {'state':'packaged','archive':str(archive),'sha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'bytes':archive.stat().st_size,'files':len(files)+1,'fixtureTests':13,'centralInstalled':False}
(root / 'evidence/central-mcp-handoff-package-20261021.json').write_text(json.dumps(proof, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(proof, ensure_ascii=False, indent=2))

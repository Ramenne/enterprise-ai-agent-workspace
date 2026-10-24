// Build only the HTTP contract under test; this does not certify a full application build.
import {spawnSync} from 'node:child_process';import {copyFile} from 'node:fs/promises';
const compiler='/srv/workspace';
const r=spawnSync(process.execPath,[compiler,'--ignoreConfig','--types','node','--typeRoots','/srv/workspace','--target','ES2023','--module','NodeNext','--moduleResolution','NodeNext','--strict','--skipLibCheck','--rootDir','.','--outDir','dist','--sourceMap','--declaration','packages/platform/src/http.ts'],{stdio:'inherit'});if(r.status!==0)process.exit(r.status??1);
await copyFile('packages/platform/src/failure-contract.mjs','dist/packages/platform/src/failure-contract.mjs');

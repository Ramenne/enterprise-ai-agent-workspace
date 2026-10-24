import{execFileSync}from'node:child_process';import{copyFile}from'node:fs/promises';
execFileSync(process.execPath,['/srv/workspace','--ignoreConfig','--target','ES2023','--module','NodeNext','--moduleResolution','NodeNext','--strict','--skipLibCheck','--esModuleInterop','--resolveJsonModule','--types','node','--rootDir','.','--outDir','dist/contract-check','apps/mcp/src/schemas.ts','apps/mcp/src/capabilities.ts'],{stdio:'inherit'});
await copyFile('packages/platform/src/failure-contract.mjs','dist/contract-check/packages/platform/src/failure-contract.mjs');

import {cp,mkdir}from'node:fs/promises';
const root=new URL('../../../',import.meta.url);const target=new URL('dist/packages/member-auth/',root);await mkdir(target,{recursive:true});await cp(new URL('../src/',import.meta.url),new URL('src/',target),{recursive:true});await cp(new URL('../public/',import.meta.url),new URL('public/',target),{recursive:true});

await cp(new URL('packages/vault/src/',root),new URL('dist/packages/vault/src/',root),{recursive:true});

await cp(new URL('packages/storage-tiers/src/',root),new URL('dist/packages/storage-tiers/src/',root),{recursive:true});

await cp(new URL('packages/vault/next/src/',root),new URL('dist/packages/vault/next/src/',root),{recursive:true});

await cp(new URL('packages/shared-resources/src/',root),new URL('dist/packages/shared-resources/src/',root),{recursive:true});

await cp(new URL('packages/legacy-application-grants/src/',root),new URL('dist/packages/legacy-application-grants/src/',root),{recursive:true});

await cp(new URL('packages/project-backups/src/',root),new URL('dist/packages/project-backups/src/',root),{recursive:true});

await cp(new URL('packages/asset-backups/src/',root),new URL('dist/packages/asset-backups/src/',root),{recursive:true});

await cp(new URL('packages/native-vault-claims/src/',root),new URL('dist/packages/native-vault-claims/src/',root),{recursive:true});

await cp(new URL('packages/platform/src/failure-contract.mjs',root),new URL('dist/packages/platform/src/failure-contract.mjs',root));

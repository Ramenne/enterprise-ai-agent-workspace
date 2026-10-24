import {copyFile} from 'node:fs/promises';
// Test the maintained MJS against its existing compiled secrets dependency.
await copyFile('packages/shared-resources/src/custody-migration.mjs','dist/packages/shared-resources/src/custody-migration.mjs');

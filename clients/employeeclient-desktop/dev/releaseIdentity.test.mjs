import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
test('Android takes its version from the same source as PWA, with no second literal version',()=>{
 const gradle=readFileSync(new URL('../android/app/build.gradle',import.meta.url),'utf8');
 assert.ok(gradle.includes('src/app/release.ts'));assert.match(gradle,/versionCode qnVersionCode/);assert.match(gradle,/versionName qnVersionName/);
 assert.ok(!/versionCode \d+/.test(gradle));assert.ok(!/versionName "\d/.test(gradle));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {routeFromNotification, notificationRoutePath} from '../src/platform/deeplink.ts';
const project='ad44cc0e-159e-4e0f-a5ca-73d3920240d9';
test('persisted hub update opens the current project work view after notification re-entry',()=>{
 const link='/business/v1/projects/'+project+'/updates';
 assert.deepEqual(routeFromNotification({kind:'hub_update',deep_link:link}),{name:'work',params:{},query:{project}});
 assert.equal(notificationRoutePath(link,'hub_update'),'/work?project='+project);
 for(const bad of ['https://outside.test'+link,link+'/extra','/business/v1/projects/not-an-id/updates'])assert.equal(routeFromNotification({kind:'hub_update',deep_link:bad}),null);
});

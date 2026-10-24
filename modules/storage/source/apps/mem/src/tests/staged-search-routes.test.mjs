import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {z} from 'zod';
import {registerStagedSearch} from '../staged-search.mjs';
const project_id='16f05f01-4a43-4e96-a16b-d8ed69eff77d';
test('legacy blank-query listing stays metadata-only; empty advanced search is rejected',async()=>{
 const app=Fastify({logger:false});let calls=[];let semanticCalls=0;
 class DomainError extends Error{}
 registerStagedSearch(app,{z,bearer:()=> 'fixture-subject',sourceFromRequest:()=>undefined,DomainError,
 call:async(t,s,n,a,b)=>{calls.push(n);return{items:[],recipe:'original_metadata_query'}},
 semantic:async()=>{semanticCalls++;return{}},findNumber:async()=>({})});
 const listing=await app.inject({method:'POST',url:'/v2/materials/search',payload:{project_id,query:''}});
 assert.equal(listing.statusCode,200);assert.equal(listing.json().recipe,'original_metadata_query');assert.deepEqual(calls,['search_materials']);assert.equal(semanticCalls,0);
 const empty=await app.inject({method:'POST',url:'/v2/materials/retrieve',payload:{project_id}});assert.notEqual(empty.statusCode,200);
 const invalid=await app.inject({method:'POST',url:'/v2/materials/retrieve',payload:{project_id,query:'test',version_created_after:'2026-10-08T00:00:00Z',version_created_before:'2026-10-07T00:00:00Z'}});assert.notEqual(invalid.statusCode,200);
 await app.close();
});

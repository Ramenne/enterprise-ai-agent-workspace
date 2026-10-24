import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {once} from 'node:events';import ts from 'typescript';
import {createHubCache} from '../src/native/hub-cache.mjs';import {NativeClient} from '../src/native/client.mjs';
import {createLocalScenario} from './reconstruction-local.mjs';import {createGateway} from '../server/gateway.mjs';
import {loadAuthorizedCatalog,attributeCatalog,valueLabel} from '../src/native/attribute-query.mjs';
import {myProjects,authorizedProjects} from '../src/native/discovery.mjs';import {workRelations,workBrief} from '../src/native/detail-model.mjs';
import {PROJECT} from '../server/business/native-authority.mjs';
test('complete work attributes come from authorized detail, then navigation reuses the same facts',async()=>{
 const scenario=createLocalScenario();
 let foreignIdentity=false;
 const fetcher=async(url,options)=>{const response=await scenario.fetcher(url,options);if(url.endsWith('/work-items/search')){const data=await response.json();data.items=data.items.map(({properties,...row})=>row);return Response.json(data);}if(url.endsWith('/authorization/permissions')){const data=await response.json();if(foreignIdentity)data.actor_id='sim-b';if(data.qualifications.length===0)data.qualifications=[{project_id:data.project_id,principal_id:'sim-a',effective_now:false,actions:['v8.work.read']}];return Response.json(data);}return response;};
 const server=createGateway({root:'/tmp',publicOrigin:'http://127.0.0.1',fetcher,businessHandler:scenario.businessHandler});server.listen(0,'127.0.0.1');await once(server,'listening');
 const base='http://127.0.0.1:'+server.address().port,db=new Map(),lease={account:'sim-a',epoch:1,valid:()=>true};
 class MemberClient extends NativeClient{constructor(){super({base,fetcher:(url,options)=>fetch(url,{...options,headers:{...options.headers,origin:'http://127.0.0.1',cookie:'simulation_member=sim-a'}})});}}
 try{
  const deps={createHubCache,NativeClient:MemberClient,loadAuthorizedCatalog,authorizedProjects,workRelations,metaGet:async(a,k)=>db.get(a+k),metaSet:async(a,k,v)=>db.set(a+k,structuredClone(v)),metaRemove:async(a,k)=>db.delete(a+k),captureApiLease:()=>lease,serviceOrigin:()=>base};
  const source=await readFile(new URL('../src/native/hub-data.ts',import.meta.url),'utf8'),code=ts.transpileModule(source.replace(/^import[^\n]+\n/gm,''),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/\bexport /g,'');
  const model=new Function(...Object.keys(deps),code+';return {readCatalog,readHubDetail,readProjects};')(...Object.values(deps));
  const projects=await model.readProjects(lease);
  assert.equal(projects.length,4);
  assert.deepEqual(myProjects(projects,lease.account).map(p=>p.title).sort(),['A 的个人项目','员工客户端']);
  const permissionsReads=scenario.counts['hufu.access.permissions'];
  await model.readProjects(lease);assert.equal(scenario.counts['hufu.access.permissions'],permissionsReads);
  foreignIdentity=true;await assert.rejects(model.readProjects(lease,{force:true}),/资格身份不一致/);foreignIdentity=false;
  const snapshots=[];const directory=await model.readCatalog(lease,{project_id:PROJECT},'work',{onSnapshot:v=>snapshots.push(structuredClone(v))}),fields=attributeCatalog(directory.rows);
  assert.ok(snapshots.length>=3);assert.equal(snapshots[0].rows.filter(r=>r.type==='work').length,2);assert.ok(!snapshots[0].rows.some(r=>r.properties?.attributes?.record_kind));
  assert.ok(fields.some(f=>f.key==='properties.attributes.record_kind'));
  assert.ok(fields.some(f=>f.key==='related_work_no'&&f.label==='关联工作'));
  assert.ok(fields.some(f=>f.key==='properties.attributes.work_no'&&f.label==='所属工作'));
  assert.ok(fields.some(f=>f.key==='updated_at'));
  assert.equal(valueLabel('in_progress','state'),'进行中');
  assert.equal(scenario.counts['v8.work.read'],2);
  await model.readCatalog(lease,{project_id:PROJECT},'work');await model.readHubDetail(lease,PROJECT,directory.rows[0].work_item_id);
  assert.equal(scenario.counts['v8.work.read'],2);assert.equal(scenario.counts['v8.work.search'],1);
  assert.equal(workBrief('已完成工作报告：18次RPC。完整记录保持原件。'),'已完成工作报告');
 }finally{await new Promise(r=>server.close(r));scenario.close();}
});

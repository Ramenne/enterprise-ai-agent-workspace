import test from 'node:test';
import assert from 'node:assert/strict';
import {attributeFields,attributeCatalog,filterAttributes,metadataMatches,valueKey,projectScopeOptions,retainAttributeSelection} from '../src/native/attribute-query.mjs';
const row={type:'file',name:'接口说明.txt',display_no:'F-1001-001',file_no:1001,properties:{attributes:{language:'中文',tags:['聊天','通知'],verified:false,count:0},简介:'很长的简介',nested:{description:'很长的正文',state:'unknown'}},projectProperties:{type:'project',summary:'不要枚举'}};
test('all typed nested and multi-value attributes are available without keyword matches or a field cap',()=>{
 const source={...row,properties:{...row.properties,attributes:{...row.properties.attributes,...Object.fromEntries(Array.from({length:24},(_,i)=>['field'+i,'value'+i]))}}};
 const fields=attributeFields(source),catalog=attributeCatalog([source]);
 assert.equal(catalog.length>24,true);assert.deepEqual(fields['properties.attributes.tags'],['聊天','通知']);assert.deepEqual(fields['properties.attributes.verified'],[false]);assert.deepEqual(fields['properties.attributes.count'],[0]);
 assert.equal(Object.keys(fields).some(k=>/简介|description|summary/.test(k)),false);
 assert.notEqual(valueKey('0'),valueKey(0));
});
test('filter combinations use AND across attributes and retain array membership, false and zero',()=>{
 const options={'properties.attributes.language':valueKey('中文'),'properties.attributes.tags':valueKey('通知'),'properties.attributes.verified':valueKey(false),'properties.attributes.count':valueKey(0)};
 assert.deepEqual(filterAttributes([row],options),[row]);assert.deepEqual(filterAttributes([row],{...options,'properties.attributes.tags':valueKey('附件')}),[]);
 assert.equal(metadataMatches(row,'F-1001'),true);assert.equal(metadataMatches(row,'接口'),true);assert.equal(metadataMatches(row,'中文'),true);
});
test('same leaf names in distinct namespaces have distinguishable dropdown labels',()=>{
 const fields=attributeCatalog([{...row,state:'active',properties:{attributes:{state:'unknown'}},projectProperties:{attributes:{state:'planned'}}}]);
 assert.equal(new Set(fields.filter(f=>f.key.endsWith('state')).map(f=>f.label)).size,3);
});
test('only actual business fields and actual team/personal scopes become dropdowns',()=>{
 const records=[{type:'file',logical_path:'原件.txt',sha256:'hash',version_id:'id',metadata_revision:8,properties:{governance:{reason:'内部审计'},source_claim:{state:'unknown'},employeeclient:{mime:'text/plain'},attributes:{material_kind:'系统使用说明',purpose:'测试'}}}];
 const keys=attributeCatalog(records).map(f=>f.key);
 assert.deepEqual(new Set(keys),new Set(['name','properties.attributes.material_kind','properties.attributes.purpose']));
 assert.equal(keys.some(k=>/language|sha256|revision|governance|source_claim|employeeclient/.test(k)),false);
 assert.deepEqual(projectScopeOptions([{visibility:'team'},{visibility:'personal'},{visibility:'private'}]),[{value:'team',label:'团队'},{value:'personal',label:'个人'}]);
 assert.deepEqual(projectScopeOptions([{visibility:'personal'}]),[{value:'personal',label:'个人'}]);
 // A language property is displayed only if it actually exists, not as a preset.
 assert.equal(attributeCatalog([{...records[0],properties:{attributes:{language:'中文'}}}]).some(f=>f.key==='properties.attributes.language'),true);
 assert.deepEqual(retainAttributeSelection(records,{'properties.attributes.language':'"中文"','properties.attributes.purpose':'"旧值"','properties.attributes.material_kind':'"系统使用说明"'}),{'properties.attributes.material_kind':'"系统使用说明"'});
});

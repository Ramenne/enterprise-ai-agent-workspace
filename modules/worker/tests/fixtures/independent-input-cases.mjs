const id='16f05f01-4a43-4e96-a16b-d8ed69eff77d',other='cbd510d3-162f-4a62-a3e3-9648cd067297';
const query={project_id:id,text:'synthetic independent contract'},fixed={project_id:id,fixed_ref:{material_id:id,version_id:other,sha256:'a'.repeat(64)}};
const begin={project_id:id,url:'https://example.invalid/synthetic',idempotency_key:'original-import-key',base_revision:0},resume={import_id:id,save_as_new:false,base_revision:0};
export const independentInputCases=[
 ['semantic-direct','mem.semantic.query',query],['semantic-payload','mem.semantic.query',{payload:query}],['semantic-mixed','mem.semantic.query',{...query,payload:query}],
 ['semantic-defaults-explicit','mem.semantic.query',{...query,top_k:10,mode:'exact',compare_exact:false,include_historical:false}],
 ['semantic-utf8-budget','mem.semantic.query',{...query,text:'字'.repeat(12000)}],['semantic-blank','mem.semantic.query',{...query,text:' '}],
 ['semantic-invalid-top','mem.semantic.query',{...query,top_k:true}],['semantic-unknown','mem.semantic.query',{...query,unknown:true}],
 ['semantic-compact-uuid','mem.semantic.query',{...query,project_id:id.replaceAll('-','')}],
 ['semantic-index','mem.semantic.index_fixed',fixed],['semantic-index-newline-hash','mem.semantic.index_fixed',{...fixed,fixed_ref:{...fixed.fixed_ref,sha256:'a'.repeat(64)+'\n'}}],
 ['semantic-payload-source','mem.semantic.query',{payload:{...query,source_context:{synthetic:true}}}],
 ['url-direct','mem.url.import',begin],['url-payload','mem.url.import',{payload:begin}],['url-mixed','mem.url.import',{...begin,payload:begin}],
 ['url-invalid-revision','mem.url.import',{...begin,base_revision:-1}],['url-extra-key','mem.url.import',{...begin,actor_id:id}],
 ['url-resume-direct','mem.url.resume',resume],['url-resume-payload','mem.url.resume',{payload:resume}],['url-status','mem.url.status',{import_id:id}]
];

export const TOOLS=new Set([
  'hufu.access.permissions', // Read-only member qualification; no application workflow.
  'v8.project.search','v8.project.read','v8.work.search','v8.work.catalog','v8.work.read','v8.work.history.page','v8.work.save','v8.statement.read_chunk',
  'mem.workspace.query','mem.material.by_path',
  'mem.enumerate','mem.enumerate.page','mem.search','mem.material.head','mem.material.history','mem.version.read','mem.read.acknowledge','mem.metadata.patch',
  'mem.upload.begin','mem.upload.ticket','mem.upload.put_status','mem.upload.put_complete','mem.upload.publish','mem.operation.get',
  'mem.upload.multipart.begin','mem.upload.multipart.part_ticket','mem.upload.multipart.parts','mem.upload.multipart.resume','mem.upload.multipart.complete','mem.upload.multipart.abort',
]);
// Contracts read from the current Hufu apps/mcp/src/tools.ts and public Mem API.
// The page RPC has a narrower menu; application calls use the member's native
// session as the official portal's V8 adapter already does. No Hufu patch.
export function nativeRoute(name,args) {
  const routes={
    // Own-account board reads are used by the authenticated business adapter only;
    // deliberately absent from the browser TOOLS menu.
    'board.member.balance':['v8','/v2/points/member-balance'],
    'board.tasks.read':['v8','/v2/board/tasks/lookup'],
    'hufu.access.permissions':['hufu','/v2/authorization/permissions'],
    'v8.project.search':['v8','/v2/projects/search'],
    'v8.project.read':['v8','/v2/projects/read'],
    'v8.work.search':['v8','/v2/work-items/search'],
    'v8.work.catalog':['v8','/v2/work-items/catalog'],
    'mem.workspace.query':['mem','/v2/materials/workspace-query'],
    'mem.material.by_path':['mem','/v2/materials/by-path'],
    'v8.work.read':['v8','/v2/work-items/read'],
    'v8.work.history.page':['v8','/v2/work-items/history/page'],
    'v8.work.save':['v8','/v2/work-items/save'],
    'v8.statement.read_chunk':['v8','/v2/statements/read-chunk'],
    'mem.enumerate':['mem','/v2/material-enumerations'],
    'mem.enumerate.page':['mem','/v2/material-enumerations/page'],
    'mem.search':['mem','/v2/materials/search'],
    'mem.material.head':['mem','/v2/materials/head'],
    'mem.material.history':['mem','/v2/materials/history'],
    'mem.metadata.patch':['mem','/v2/materials/metadata'],
    'mem.version.read':['mem','/v2/files/read-chunk'],
    'mem.read.acknowledge':['mem','/v2/read-receipts'],
    'mem.upload.begin':['mem','/v2/uploads'],
    'mem.operation.get':['mem','/v2/operations/query'],
  };
  if(['actor','actor_id','subject','subject_id'].some(k=>Object.hasOwn(args,k)))return null;
  const upload={'mem.upload.ticket':'put-ticket','mem.upload.put_status':'put/status','mem.upload.put_complete':'put/complete','mem.upload.publish':'publish',
    'mem.upload.multipart.begin':'multipart/begin','mem.upload.multipart.part_ticket':'multipart/part-ticket','mem.upload.multipart.parts':'multipart/list','mem.upload.multipart.resume':'multipart/resume','mem.upload.multipart.complete':'multipart/complete','mem.upload.multipart.abort':'multipart/abort'};
  if(upload[name]){
    if(typeof args.operation_id!=='string'||!(/^[0-9a-f-]{36}$/i).test(args.operation_id))return null;
    const {operation_id,...body}=args;
    return {path:'/hub2-preview/mem/v2/uploads/'+operation_id+'/'+upload[name],body};
  }
  const route=routes[name];
  return route?{path:'/hub2-preview/'+route[0]+route[1],body:args}:null;
}

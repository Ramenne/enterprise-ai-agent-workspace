// Last verified workspace is a local reading hint, never an authentication grant.
const key='qn.last-verified-workspace.v1';
export function readWorkspaceResume(storage=localStorage){try{const v=JSON.parse(storage.getItem(key)||'null');return v&&typeof v.account==='string'&&/^[A-Za-z0-9:_.-]{1,128}$/.test(v.account)&&typeof v.name==='string'?{account:v.account,name:v.name.slice(0,200)}:null;}catch{return null;}}
export function rememberWorkspace(user,storage=localStorage){if(!user?.username)return;try{storage.setItem(key,JSON.stringify({account:user.username,name:user.nickname||user.username}));}catch{}}
export function forgetWorkspace(storage=localStorage){try{storage.removeItem(key);}catch{}}

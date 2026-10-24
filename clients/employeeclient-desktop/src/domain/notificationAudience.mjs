// A project revision diff is a synchronization hint, not an identified human
// action. It cannot establish "someone else changed something relevant to me".
export function isRelevantNotice(note, account='') {
 const reminder=note.priority==='urgent'||note.snapshot?.reminder===true||note.kind==='device_alert';
 if(note.kind==='hub_update'&&note.snapshot?.source==='authorized_project_commit_snapshot'&&!reminder)return false;
 if(account&&note.actor_username===account&&!reminder)return false;
 return true;
}

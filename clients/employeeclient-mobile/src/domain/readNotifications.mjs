// Each action is still authorized by the server. Do not continue a denied batch
// or label failed/unattempted rows as read. Gone rows are independently evicted.
export async function readNotificationBatch(targets,act,valid){
 let read=0,gone=0,failed=0,cancelled=false;
 for(const n of targets){if(!valid()){cancelled=true;break;}const result=await act(n);if(!valid()){cancelled=true;break;}if(result===true)read++;else if(result==='gone')gone++;else{failed++;break;}}
 return {read,gone,failed,cancelled,remaining:targets.length-read-gone};
}

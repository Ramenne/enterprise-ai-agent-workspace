// Origin-wide cache/database protection. Does not promise Cookie retention.
export function createStoragePersistence({storage,secure=true}={}){
 let flight;
 return function ensure(){
  if(flight)return flight;
  flight=(async()=>{
   if(!secure||!storage||typeof storage.persist!=='function')return {state:'unsupported'};
   try{
    if(typeof storage.persisted==='function'&&await storage.persisted())return {state:'granted'};
    return {state:await storage.persist()?'granted':'denied'};
   }catch{return {state:'unavailable'};}
  })();
  return flight;
 };
}
export const ensurePwaStoragePersistence=createStoragePersistence({
 storage:globalThis.navigator?.storage,secure:globalThis.isSecureContext===true,
});

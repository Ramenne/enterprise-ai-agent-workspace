import {AsyncLocalStorage} from 'node:async_hooks';
/** Entry identity is request-local addressing context, never a domain authorization result. */
export function createEntryAuthentication({resolveNative,resolveLegacy}){
 const storage=new AsyncLocalStorage();
 return {
  currentIdentity(token){const record=storage.getStore();return record?.active&&record.token===token?record.identity:null;},
  async run(token,action){
   let identity=null;
   try{if(typeof token!=='string'||!token)throw Object.assign(Error('unauthenticated'),{status:401});if(token.startsWith('hub2_'))identity=await resolveNative(token);else await resolveLegacy(token);}
   catch(e){const unavailable=(e.status||500)>=500;throw Object.assign(Error(unavailable?'identity_service_unavailable':'unauthenticated'),{status:unavailable?503:401});}
   const record={token,identity,active:true};
   return storage.run(record,async()=>{try{return await action();}finally{record.active=false;}});
  }
 };
}

import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createGateway} from './gateway-factory.mjs';
export * from './gateway-factory.mjs';
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const business=process.env.QN_BUSINESS_DB?await (await import('./business/runtime.mjs')).openRegisteredBusiness():null;
  const server=createGateway({publicOrigin:process.env.QN_PUBLIC_ORIGIN||'http://localhost:5176',nativeOrigins:(process.env.QN_NATIVE_ORIGINS||'').split(',').filter(Boolean),persistentLoginEnabled:process.env.QN_PERSISTENT_MEMBER_LOGIN==='1',businessHandler:business?.handler});
  server.once('close',()=>{business?.handler.close();business?.db.close();});
  server.listen(Number(process.env.QN_PORT||8936),'127.0.0.1',()=>console.log('EmployeeClient native gateway listening'));
}

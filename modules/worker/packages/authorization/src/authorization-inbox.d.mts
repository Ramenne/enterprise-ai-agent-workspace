export const authorizationInboxContract: Record<string, any>;
export function createAuthorizationInbox(options: {pool:any;invoke:(path:string,token:string,body:any)=>Promise<any>}): (token:string,body?:any)=>Promise<any>;

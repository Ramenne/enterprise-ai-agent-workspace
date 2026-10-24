import type pg from 'pg';
export function wechatEntryPlugin(config:{pool:pg.Pool;prefix:string;secret:string;secure?:boolean;wechat?:{appId:string;provider:{authorizationUrl:(state:string)=>URL;exchange:(code:string)=>Promise<{provider:'wechat';app_id:string;open_id:string}>}}}):any;

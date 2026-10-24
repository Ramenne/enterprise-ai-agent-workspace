export function businessRequest(base:string,method:string,path:string,options?:{
 lease:{valid:()=>boolean};body?:unknown;query?:Record<string,string|number|boolean|null|undefined>;
 key?:string;signal?:AbortSignal;timeout?:number;onUnauthorized?:()=>void;fetcher?:typeof fetch;
}):Promise<unknown>;

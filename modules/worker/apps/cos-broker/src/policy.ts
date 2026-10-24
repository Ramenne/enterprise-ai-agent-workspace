import {createHash} from 'node:crypto';
/** Execution resources are controller-selected. This is not an Agent judgment engine. */
export const TARGET=Object.freeze({region:'ap-guangzhou',bucket:'hub2-data-1316920087',appid:'1316920087'});
export const MANAGEMENT_REF='bao:hub2/hufu/providers/cos-management';
export const CONSUMER_REFS=Object.freeze({mem:'bao:hub2/object-store/mem',worker:'bao:hub2/object-store/worker'});
export type Consumer=keyof typeof CONSUMER_REFS;
export interface PolicyStatement {effect:'allow';action:string[];resource:string[];condition?:Record<string,Record<string,string|string[]>>;}
export interface LeasePolicy {version:'2.0';statement:PolicyStatement[];}
const resource=(prefix:string)=>`qcs::cos:${TARGET.region}:uid/${TARGET.appid}:${TARGET.bucket}/${prefix}*`;
const READ=['HeadObject','GetObject','GetObjectVersion'];
const WRITE=['PutObject','PutObjectCopy','InitiateMultipartUpload','UploadPart','UploadPartCopy','ListParts','CompleteMultipartUpload','AbortMultipartUpload'];
// Provider-verified by A1 on 2026-10-01: exact staging UUID works; missing/root/
// other-prefix/final/old-bucket requests fail. Conditions compare URL-encoded prefix.
// Shared Mem namespace is not a per-upload identity; HTTP binds the exact operation.
export const MEM_MULTIPART_LIST:PolicyStatement={effect:'allow',action:['name/cos:ListMultipartUploads'],resource:[resource('')],condition:{string_like:{'cos:prefix':['staging%2F*']},string_not_equal:{'cos:prefix':['staging%2F']}}};
export function leasePolicy(domain:Consumer):LeasePolicy {
 const objects:PolicyStatement={effect:'allow',action:(domain==='mem'?[...READ,...WRITE]:READ).map(a=>'name/cos:'+a),resource:domain==='mem'?[resource('staging/'),resource('final/')]:[resource('final/')]};
 if(domain==='mem'){
  return {version:'2.0',statement:[objects,MEM_MULTIPART_LIST]};
 }
 return {version:'2.0',statement:[objects]};
}
export function policyHash(policy:LeasePolicy):string{return createHash('sha256').update(JSON.stringify(policy)).digest('hex');}

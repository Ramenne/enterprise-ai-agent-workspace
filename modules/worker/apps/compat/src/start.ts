import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createCompatServer,mappingManifest} from './server.js';
import {run} from '../../../packages/platform/src/http.js';
const path=process.env['HUB_COMPAT_MANIFEST'];if(!path)throw new Error('reviewed_mapping_manifest_required');
const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
let manifest;
try{const stat=await file.stat();if(!stat.isFile()||(stat.mode&0o022)!==0||stat.size>32*1024*1024)throw new Error('unsafe_mapping_manifest');manifest=mappingManifest.parse(JSON.parse(await file.readFile('utf8')));}finally{await file.close();}
await run(createCompatServer({memUrl:process.env['MEM_URL']??'http://127.0.0.1:4612',manifest}),Number(process.env['COMPAT_PORT']??4616));

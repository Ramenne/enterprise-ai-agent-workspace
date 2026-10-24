import {build} from 'esbuild';
const outfile=process.argv[2]||'server/gateway.runtime.mjs';
await build({entryPoints:['server/gateway.mjs'],bundle:true,platform:'node',format:'esm',target:'node24',outfile,banner:{js:"import { createRequire as qnCreateRequire } from 'node:module'; const require = qnCreateRequire(import.meta.url);"}});
console.log('Standalone gateway generated: '+outfile);

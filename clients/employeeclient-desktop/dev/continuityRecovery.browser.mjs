import {createServer} from 'node:http';import {readFile,writeFile} from 'node:fs/promises';import {createRequire} from 'node:module';import ts from 'typescript';
const require=createRequire(import.meta.url),{chromium}=require('/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const compile=async(path,prefix)=>prefix+ts.transpileModule(await readFile(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/^import .*;\n/gm,'');
const transport=await compile('../src/platform/liveTransport.ts','const {registerPlugin,captureApiLease,ApiError,servicePath,metaGet,isAndroidNative}=window.__deps;\n');
const link=await compile('../src/platform/liveLink.ts',"import {createRecoveryGate} from '/gate.js';\nconst {App,Network,ApiError,isOnline,isAndroidNative,NativeLive,connectStream}=window.__linkDeps;\n");
const gate=await readFile(new URL('../src/platform/recoveryGate.mjs',import.meta.url),'utf8');
let connections=0,syncs=0,identities=0;const timers=new Set(),responses=new Set();
const server=createServer((req,res)=>{
 if(req.url==='/gate.js'){res.setHeader('content-type','text/javascript');res.end(gate);return;}
 if(req.url==='/transport.js'||req.url==='/link.js'){res.setHeader('content-type','text/javascript');res.end(req.url==='/transport.js'?transport:link);return;}
 if(req.url?.startsWith('/business/v1/events')){connections++;responses.add(res);res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'});const first=connections===1;
 res.write(first?': partial\n':'event: ready\ndata: {"actor_id":"a","catchup":true}\n\nevent: change\ndata: {"catchup":true,"kinds":[]}\n\n');
 const timer=setInterval(()=>res.write(first?': partial\n':'event: ping\ndata: {}\n\n'),10000);timers.add(timer);res.on('close',()=>{clearInterval(timer);timers.delete(timer);responses.delete(res);});return;}
 if(req.url==='/sync'){syncs++;res.end('{}');return;}
 if(req.url==='/native/session'){identities++;res.writeHead(500);res.end('{}');return;}
 res.setHeader('content-type','text/html');res.end('<!doctype html><title>EmployeeClient isolated connection recovery</title>');
});await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
try{browser=await chromium.launch({headless:true,executablePath:'/Users/developer/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'});const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port);const started=Date.now();
 await page.evaluate(async()=>{class ApiError extends Error{constructor(code,hint,status){super(hint);this.code=code;this.status=status;}get needsAuth(){return this.code==='unauthenticated';}}
 window.__deps={registerPlugin:()=>({}),captureApiLease:()=>({account:'a',valid:()=>true}),ApiError,servicePath:p=>p,metaGet:async()=>0,isAndroidNative:()=>false};const transport=await import('/transport.js');transport.noteVerifiedTransportIdentity('a');
 window.__linkDeps={App:{addListener:async()=>({remove:async()=>{}})},Network:{addListener:async()=>({remove:async()=>{}})},ApiError,isOnline:()=>true,isAndroidNative:()=>false,NativeLive:{},connectStream:transport.connectStream};const link=await import('/link.js');window.__link=link;window.__ticks=0;link.startLiveLink({account:'a',shouldRun:()=>true,onTick:async()=>{await fetch('/sync');window.__ticks++;}});});
 await page.waitForFunction(()=>window.__ticks===1,{},{timeout:60000});const result={passed:true,elapsed_ms:Date.now()-started,connections,syncs,identity_requests:identities,transport:'real HTTP in headless Chromium; synthetic identity',physical_device:false};if(connections!==2||syncs!==1||identities!==0)throw Error(JSON.stringify(result));console.log(JSON.stringify(result));await writeFile(process.argv[2]||'/tmp/qn-continuity-browser.json',JSON.stringify(result,null,2));await page.evaluate(()=>window.__link.stopLiveLink());
}finally{await browser?.close();for(const t of timers)clearInterval(t);for(const r of responses)r.destroy();server.closeAllConnections();await new Promise(r=>server.close(r));}

// Synthetic quote lifecycle whose original is outside the initial history window.
import {startQuoteReturnPreview} from './quoteReturn.preview.mjs';
const port=Number(process.env.QN_QUOTE_LIFECYCLE_PORT||5406);
const fixture=startQuoteReturnPreview(port,({scenario,ctx,members})=>{
 const original=scenario.repository.send(ctx,{body:'跨历史页原话：撤回后不能继续显示这段内容'},'lifecycle-original',{members}).message;
 const hideOriginal=scenario.repository.send(ctx,{body:'另一条跨页原话：本人隐藏只影响本人'},'lifecycle-hide-original',{members}).message;
 for(let i=0;i<80;i++)scenario.repository.send(ctx,{body:'引用生命周期中间记录 '+i},'lifecycle-filler-'+i,{members});
 const quoted=scenario.repository.send(ctx,{body:'跨历史页引用验证',reply_to_id:original.id},'lifecycle-quote',{members}).message;
 const hideQuoted=scenario.repository.send(ctx,{body:'本人隐藏引用验证',reply_to_id:hideOriginal.id},'lifecycle-hide-quote',{members}).message;
 return {originalOutside:original,quotedOutside:quoted,hideOriginal,hideQuoted};
},{host:'quote-check.localhost'});
const metrics=[],handler=fixture.server.listeners('request')[0];fixture.server.removeAllListeners('request');
fixture.server.on('request',(req,res)=>{
 if(req.url==='/simulation/quote-lifecycle'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({scope:'synthetic loopback only',original:fixture.originalOutside.id,quoted:fixture.quotedOutside.id,hideOriginal:fixture.hideOriginal.id,hideQuoted:fixture.hideQuoted.id,metrics}));return;}
 if(req.url?.startsWith('/business/v1/messages/changes')){const end=res.end.bind(res);res.end=(chunk,...args)=>{let data;try{data=JSON.parse(String(chunk));}catch{}metrics.push({url:req.url,status:res.statusCode,cursor:data?.next_change_cursor,changed:data?.changes?.map(c=>c.message.id)});return end(chunk,...args);};}
 handler(req,res);
});
console.log('SYNTHETIC ONLY http://quote-check.localhost:'+port+'/simulation/sim-a');
const stop=()=>{fixture.server.closeAllConnections();fixture.server.close(()=>process.exit(0));};
process.on('SIGINT',stop);process.on('SIGTERM',stop);

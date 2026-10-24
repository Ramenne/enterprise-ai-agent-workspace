import {readFileSync} from 'node:fs';
export async function auditAccessibility(page, report, routes, overlays){
 await page.addScriptTag({content:readFileSync(process.env.QN_AXE_SCRIPT,'utf8')});
 report.accessibility=[];
 const scan=async label=>{
  const result=await page.evaluate(async()=>window.axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','wcag22aa']}}));
  report.accessibility.push({label,passes:result.passes.length,incomplete:result.incomplete.map(x=>x.id),violations:result.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary,html:n.html}))}))});
 };
 for(const route of routes){for(const width of [390,1440]){
  await page.setViewportSize({width,height:844});await page.evaluate(r=>window.audit.go(r,'normal',r==='/reviews'?'control':'member'),route);await page.waitForTimeout(50);await scan(route+'-'+width);
 }}
 await page.evaluate(()=>window.audit.go('/work','normal','control'));
 for(const [kind,props] of Object.entries(overlays)){await page.setViewportSize({width:390,height:844});await page.evaluate(([k,p])=>window.audit.open(k,p),[kind,props]);await page.waitForTimeout(50);await scan('overlay-'+kind);await page.evaluate(()=>window.audit.ui.closeOverlay());await page.waitForTimeout(10)}
 const failures=report.accessibility.filter(r=>r.violations.length);
 if(failures.length)report.failures.push({accessibilityFailures:failures.length});
 console.log(JSON.stringify({accessibilityScans:report.accessibility.length,failures:failures.map(x=>({label:x.label,violations:x.violations}))}));
}

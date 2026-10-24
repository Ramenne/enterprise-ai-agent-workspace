from pathlib import Path
p=Path('/srv/workspace');s=p.read_text()
if 'createApplicationSso' not in s:s="import{createApplicationSso,applicationSsoTargets}from'./application-sso.mjs';\n"+s
s=s.replace("const TARGETS={mem:","const TARGETS={baize_hufu2:'https://baize.example.invalid/',tools_hufu2:'https://tools.example.invalid/',mem:")
needle="const random=()=>randomBytes(32).toString('base64url');"
if 'const applicationSso=createApplicationSso' not in s:s=s.replace(needle,"const applicationSso=createApplicationSso({handoffSession,identity,tickets,consumers:secret,call});\n"+needle)
needle=" if(path==='/api/sso/exchange'&&req.method==='POST'){"
check=" if(path==='/api/application-sso/check'&&req.method==='POST')return json(res,await applicationSso.check(req,await body(req),timingSafeEqual));\n"
if check not in s:s=s.replace(needle,check+needle)
needle="  const b=await body(req);const supplied=req.headers['x-hub-consumer-key']||'',known=secret[b.target]||'';"
new="  const b=await body(req);if(applicationSsoTargets[b.target])return json(res,await applicationSso.exchange(req,b,timingSafeEqual));const supplied=req.headers['x-hub-consumer-key']||'',known=secret[b.target]||'';"
assert needle in s;s=s.replace(needle,new)
s=s.replace("target==='baize'&&targetHost==='service.example.invalid'", "target==='baize'&&targetHost==='service.example.invalid'||applicationSsoTargets[target]?.host===targetHost")
s=s.replace("const cb=target==='baize'?'/hub-sso/callback':'/portal/sso/callback'", "const cb=applicationSsoTargets[target]?.callback||(target==='baize'?'/hub-sso/callback':'/portal/sso/callback')")
p.write_text(s)

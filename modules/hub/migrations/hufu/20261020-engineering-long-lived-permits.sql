-- Long-lived qualifications stay revocable; executable permits stay bounded.
DO $patch$
DECLARE definition text;old_text text;new_text text;
BEGIN
 definition:=pg_get_functiondef('authz.engineering_access(text,uuid,text)'::regprocedure);
 old_text:='''deadline'',least(d,b.expires_at,CASE';
 new_text:='''deadline'',least(clock_timestamp()+interval ''30 minutes'',d,b.expires_at,CASE';
 IF strpos(definition,new_text)=0 THEN
  IF strpos(definition,old_text)=0 THEN RAISE EXCEPTION 'engineering_access_source_changed'; END IF;
  EXECUTE replace(definition,old_text,new_text);
 END IF;
 definition:=pg_get_functiondef('authz.engineering_catalog(text)'::regprocedure);
 old_text:='''expires_at'',CASE WHEN permit->>''engineering_authority_source''=''organization_supervisor'' THEN NULL ELSE permit->''deadline'' END';
 new_text:='''expires_at'',CASE WHEN permit->>''engineering_authority_source''=''organization_supervisor'' THEN NULL ELSE (SELECT to_jsonb(q.expires_at) FROM authz.qualifications q WHERE q.id=(permit->>''qualification_id'')::uuid) END,''until_revoked'',CASE WHEN permit->>''engineering_authority_source''=''organization_supervisor'' THEN true ELSE (SELECT q.until_revoked FROM authz.qualifications q WHERE q.id=(permit->>''qualification_id'')::uuid) END';
 IF strpos(definition,new_text)=0 THEN
  IF strpos(definition,old_text)=0 THEN RAISE EXCEPTION 'engineering_catalog_source_changed'; END IF;
  EXECUTE replace(definition,old_text,new_text);
 END IF;
END $patch$;
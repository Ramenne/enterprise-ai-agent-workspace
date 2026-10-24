SET ROLE hub2_authz_owner;
DO $service_bridge$
DECLARE before text;after text;
BEGIN
 before:=pg_get_functiondef('authz.legacy_bridge_finish(uuid,text,text,text,text[],text,timestamptz,text,text)'::regprocedure);
 after:=replace(before,$match$p.kind<>'member'$match$, $kind$(p.kind NOT IN('member','service') OR(p.kind='service'AND NOT EXISTS(SELECT FROM vault2.service_bindings sb WHERE sb.principal_id=p.id AND sb.legacy_subject=subject AND sb.active)))$kind$);
 after:=replace(after,'expiry,true,''legacy_hufu_verified'',m.id','expiry,p.kind=''member'',CASE WHEN p.kind=''service''THEN ''registered_legacy_service_verified''ELSE ''legacy_hufu_verified''END,m.id');
 after:=replace(after,'''is_primary'',true,''credential_type'',''primary_member''',$result$'is_primary',p.kind='member','credential_type',CASE WHEN p.kind='service'THEN 'registered_service_access'ELSE 'primary_member'END$result$);
 IF after=before OR position('registered_legacy_service_verified'IN after)=0 THEN RAISE EXCEPTION 'current_legacy_bridge_shape_requires_review';END IF;
 EXECUTE after;
END $service_bridge$;
RESET ROLE;

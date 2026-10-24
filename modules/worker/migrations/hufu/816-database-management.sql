BEGIN;
CREATE OR REPLACE FUNCTION authz.database_permissions_read(proof text,b jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;items jsonb;
BEGIN
 i:=authz.authenticate(proof);
 IF coalesce(b->>'view','mine') NOT IN ('mine','managed') THEN RAISE EXCEPTION 'invalid_view' USING ERRCODE='22023';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(g)||jsonb_build_object('effective_now',g.active AND g.expires_at>clock_timestamp())),'[]') INTO items FROM authz.database_permissions g WHERE ((coalesce(b->>'view','mine')='mine' AND g.actor_id=(i->>'actor_id')::uuid AND authz.client_resource_allowed745((i->>'client_id')::uuid,g.project_id)) OR (b->>'view'='managed' AND authz.engineering_can_manage(proof,g.project_id))) AND (NOT b ? 'project_id' OR g.project_id=(b->>'project_id')::uuid);
 RETURN jsonb_build_object('state','read','items',items,'effective_now_note','active and unexpired;each operation also rechecks issuer,client and object');
END $$;
REVOKE ALL ON FUNCTION authz.database_permissions_read(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.database_permissions_read(text,jsonb) TO hub2_hufu;
CREATE OR REPLACE FUNCTION authz.database_expire() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz SET lock_timeout='2s' AS $$
DECLARE g authz.database_permissions;o jsonb;cnt integer:=0;
BEGIN
 IF authz.runtime_role()<>'hub2_hufu' THEN RAISE EXCEPTION 'service_required' USING ERRCODE='42501';END IF;
 FOR g IN SELECT * FROM authz.database_permissions WHERE active AND expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 30 FOR UPDATE SKIP LOCKED LOOP
  FOR o IN SELECT value FROM jsonb_array_elements(g.objects) LOOP
   IF to_regclass(format('%I.%I',o->>'schema',o->>'table'))::oid=(o->>'relation_oid')::oid THEN EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I',g.role_name,o->>'schema',o->>'table');END IF;
  END LOOP;
  EXECUTE format('DROP OWNED BY %I',g.role_name);EXECUTE format('DROP ROLE %I',g.role_name);
  UPDATE authz.database_permissions SET active=false,revoked_at=clock_timestamp() WHERE id=g.id;
  cnt:=cnt+1;
 END LOOP;
 RETURN jsonb_build_object('state','expired_permissions_released','count',cnt);
END $$;
REVOKE ALL ON FUNCTION authz.database_expire() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.database_expire() TO hub2_hufu;
COMMIT;

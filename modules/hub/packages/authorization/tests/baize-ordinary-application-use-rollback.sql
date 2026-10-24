CREATE OR REPLACE FUNCTION authz.authorization_application_decision(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;t authz.application_targets;act text;deadline timestamptz;
BEGIN
 i:=authz.authenticate(proof);SELECT * INTO t FROM authz.application_targets WHERE application_id=b->>'application_id' AND active;
 IF t.application_id IS NULL OR b->>'action' NOT IN('read','write') OR b->>'action' IS NULL THEN RAISE EXCEPTION 'application_or_action_required' USING ERRCODE='22023';END IF;
 act:=CASE WHEN b->>'action'='read' THEN 'mem.read' ELSE 'mem.write' END;
 deadline:=authz.resource_deadline((i->>'actor_id')::uuid,(i->>'client_id')::uuid,t.project_id,act,jsonb_build_object('project_id',t.project_id));
 IF NOT(i->>'until_revoked')::boolean THEN deadline:=least(deadline,(i->>'expires_at')::timestamptz);END IF;
 IF deadline<=clock_timestamp() THEN RAISE EXCEPTION 'application_permission_expired' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('state','allowed','actor_id',i->>'actor_id','client_id',i->>'client_id','project_id',t.project_id,'application_id',t.application_id,'action',b->>'action','deadline',CASE WHEN isfinite(deadline) THEN to_jsonb(deadline) ELSE to_jsonb('until_revoked'::text) END,'member_profile',authz.member_profile_self(proof),'note','application_personal_record_ownership_must_also_be_respected');
END $$;

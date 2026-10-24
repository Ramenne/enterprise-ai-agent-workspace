-- Original function preserved separately. No principal, grant or credential changes.
DO $baseline$ BEGIN IF (SELECT prosrc FROM pg_proc WHERE oid='authz.authorization_application_decision(text,jsonb)'::regprocedure) IS DISTINCT FROM $original$
DECLARE i jsonb;t authz.application_targets;act text;deadline timestamptz;
BEGIN
 i:=authz.authenticate(proof);SELECT * INTO t FROM authz.application_targets WHERE application_id=b->>'application_id' AND active;
 IF t.application_id IS NULL OR b->>'action' NOT IN('read','write') OR b->>'action' IS NULL THEN RAISE EXCEPTION 'application_or_action_required' USING ERRCODE='22023';END IF;
 act:=CASE WHEN b->>'action'='read' THEN 'mem.read' ELSE 'mem.write' END;
 deadline:=authz.resource_deadline((i->>'actor_id')::uuid,(i->>'client_id')::uuid,t.project_id,act,jsonb_build_object('project_id',t.project_id));
 IF NOT(i->>'until_revoked')::boolean THEN deadline:=least(deadline,(i->>'expires_at')::timestamptz);END IF;
 IF deadline<=clock_timestamp() THEN RAISE EXCEPTION 'application_permission_expired' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('state','allowed','actor_id',i->>'actor_id','client_id',i->>'client_id','project_id',t.project_id,'application_id',t.application_id,'action',b->>'action','deadline',CASE WHEN isfinite(deadline) THEN to_jsonb(deadline) ELSE to_jsonb('until_revoked'::text) END,'member_profile',authz.member_profile_self(proof),'note','application_personal_record_ownership_must_also_be_respected');
END $original$ THEN RAISE EXCEPTION 'application_decision_baseline_changed';END IF;END $baseline$;
CREATE OR REPLACE FUNCTION authz.authorization_application_decision(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;t authz.application_targets;act text;deadline timestamptz;application_use boolean;profile jsonb;
BEGIN
 i:=authz.authenticate(proof);SELECT * INTO t FROM authz.application_targets WHERE application_id=b->>'application_id' AND active;
 IF t.application_id IS NULL OR b->>'action' NOT IN('read','write') OR b->>'action' IS NULL THEN RAISE EXCEPTION 'application_or_action_required' USING ERRCODE='22023';END IF;
 -- App employees operate their own business records; project work authority
 -- remains mandatory for Mem/V8 and all unregistered application mutations.
 -- The application must still enforce ownership on every session operation.
 profile:=authz.member_profile_self(proof);
 application_use:=coalesce(t.application_id='baize'
  AND t.project_id='3527ac31-0643-4f89-a6bd-b1e9768b2e42'::uuid
  AND b->>'action'='write'
  AND authz.ordinary_member_client901((i->>'client_id')::uuid)
  AND b->'resource'->>'method'='POST'
  AND (b->'resource'->>'route'='/api/v1/sessions/start'
    OR b->'resource'->>'route' ~ '^/api/v1/sessions/([A-Za-z0-9_-]{24}|[a-f0-9]{32})/(seal|upload-complete|finish|resume-empty|chunks/seal)$')
  AND nullif(profile->>'legacy_subject','') IS NOT NULL
  AND EXISTS(SELECT FROM authz.principals p JOIN v8.projects pr ON pr.organization_id=p.organization_id
    WHERE p.id=(i->>'actor_id')::uuid AND p.kind='member' AND p.active
      AND pr.id=t.project_id AND pr.kind='project' AND pr.visibility='team' AND pr.state='active'),false);
 -- Membership/read scope is the foundation for registered app use, not a
 -- substitute write grant. The decision retains the actual write and POST.
 act:=CASE WHEN b->>'action'='read' OR application_use THEN 'mem.read' ELSE 'mem.write' END;
 deadline:=authz.resource_deadline((i->>'actor_id')::uuid,(i->>'client_id')::uuid,t.project_id,act,jsonb_build_object('project_id',t.project_id));
 IF NOT(i->>'until_revoked')::boolean THEN deadline:=least(deadline,(i->>'expires_at')::timestamptz);END IF;
 IF deadline<=clock_timestamp() THEN RAISE EXCEPTION 'application_permission_expired' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('state','allowed','actor_id',i->>'actor_id','client_id',i->>'client_id','project_id',t.project_id,'application_id',t.application_id,'action',b->>'action','deadline',CASE WHEN isfinite(deadline) THEN to_jsonb(deadline) ELSE to_jsonb('until_revoked'::text) END,'member_profile',profile,'authority_kind',CASE WHEN application_use THEN 'application_use' ELSE 'project_work' END,'note','application_personal_record_ownership_must_also_be_respected');
END $$;

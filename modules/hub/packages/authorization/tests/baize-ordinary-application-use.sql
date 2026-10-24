-- Disposable temp fixtures, all effects rolled back; no employee rows or credentials.

CREATE TEMP TABLE application_targets(application_id text,project_id uuid,active boolean);
CREATE TEMP TABLE principals(id uuid,organization_id uuid,kind text,active boolean);
CREATE TEMP TABLE projects(id uuid,organization_id uuid,kind text,visibility text,state text);
INSERT INTO application_targets VALUES ('baize','3527ac31-0643-4f89-a6bd-b1e9768b2e42',true),('tools','00000000-0000-0000-0000-000000000002',true);
INSERT INTO principals VALUES('00000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-000000000020','member',true);
INSERT INTO projects VALUES('3527ac31-0643-4f89-a6bd-b1e9768b2e42','00000000-0000-0000-0000-000000000020','project','team','active');
CREATE FUNCTION pg_temp.authenticate(proof text) RETURNS jsonb LANGUAGE plpgsql AS $f$ BEGIN
 IF proof='revoked' THEN RAISE EXCEPTION 'unauthenticated' USING ERRCODE='28000';END IF;
 RETURN jsonb_build_object('actor_id','00000000-0000-0000-0000-000000000010','client_id',CASE WHEN proof='restricted' THEN '00000000-0000-0000-0000-000000000099' ELSE '00000000-0000-0000-0000-000000000011' END,'until_revoked',proof<>'expired','expires_at','2000-01-01T00:00:00Z');END $f$;
CREATE FUNCTION pg_temp.ordinary_member_client901(cid uuid) RETURNS boolean LANGUAGE sql AS $f$ SELECT cid='00000000-0000-0000-0000-000000000011'::uuid $f$;
CREATE FUNCTION pg_temp.member_profile_self(proof text) RETURNS jsonb LANGUAGE sql AS $f$ SELECT jsonb_build_object('legacy_subject',CASE WHEN proof='unmapped' THEN '' ELSE 'synthetic-owner' END) $f$;
CREATE FUNCTION pg_temp.resource_deadline(actor uuid,client uuid,project uuid,action text,resource jsonb) RETURNS timestamptz LANGUAGE plpgsql AS $f$ BEGIN
 IF action<>'mem.read' THEN RAISE EXCEPTION 'member_qualification_required' USING ERRCODE='42501';END IF;
 IF client='00000000-0000-0000-0000-000000000099'::uuid THEN RAISE EXCEPTION 'restricted_credential_scope_required' USING ERRCODE='42501';END IF;
 IF NOT EXISTS(SELECT FROM pg_temp.principals p JOIN pg_temp.projects pr ON pr.organization_id=p.organization_id WHERE p.id=actor AND p.active AND pr.id=project AND pr.visibility='team' AND pr.state='active') THEN RAISE EXCEPTION 'invalid_project_resource' USING ERRCODE='42501';END IF;
 RETURN 'infinity';END $f$;
CREATE OR REPLACE FUNCTION pg_temp.authorization_application_decision(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE i jsonb;t pg_temp.application_targets;act text;deadline timestamptz;application_use boolean;profile jsonb;
BEGIN
 i:=pg_temp.authenticate(proof);SELECT * INTO t FROM pg_temp.application_targets WHERE application_id=b->>'application_id' AND active;
 IF t.application_id IS NULL OR b->>'action' NOT IN('read','write') OR b->>'action' IS NULL THEN RAISE EXCEPTION 'application_or_action_required' USING ERRCODE='22023';END IF;
 -- App employees operate their own business records; project work authority
 -- remains mandatory for Mem/V8 and all unregistered application mutations.
 -- The application must still enforce ownership on every session operation.
 profile:=pg_temp.member_profile_self(proof);
 application_use:=coalesce(t.application_id='baize'
  AND t.project_id='3527ac31-0643-4f89-a6bd-b1e9768b2e42'::uuid
  AND b->>'action'='write'
  AND pg_temp.ordinary_member_client901((i->>'client_id')::uuid)
  AND b->'resource'->>'method'='POST'
  AND (b->'resource'->>'route'='/api/v1/sessions/start'
    OR b->'resource'->>'route' ~ '^/api/v1/sessions/([A-Za-z0-9_-]{24}|[a-f0-9]{32})/(seal|upload-complete|finish|resume-empty|chunks/seal)$')
  AND nullif(profile->>'legacy_subject','') IS NOT NULL
  AND EXISTS(SELECT FROM pg_temp.principals p JOIN pg_temp.projects pr ON pr.organization_id=p.organization_id
    WHERE p.id=(i->>'actor_id')::uuid AND p.kind='member' AND p.active
      AND pr.id=t.project_id AND pr.kind='project' AND pr.visibility='team' AND pr.state='active'),false);
 -- Membership/read scope is the foundation for registered app use, not a
 -- substitute write grant. The decision retains the actual write and POST.
 act:=CASE WHEN b->>'action'='read' OR application_use THEN 'mem.read' ELSE 'mem.write' END;
 deadline:=pg_temp.resource_deadline((i->>'actor_id')::uuid,(i->>'client_id')::uuid,t.project_id,act,jsonb_build_object('project_id',t.project_id));
 IF NOT(i->>'until_revoked')::boolean THEN deadline:=least(deadline,(i->>'expires_at')::timestamptz);END IF;
 IF deadline<=clock_timestamp() THEN RAISE EXCEPTION 'application_permission_expired' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('state','allowed','actor_id',i->>'actor_id','client_id',i->>'client_id','project_id',t.project_id,'application_id',t.application_id,'action',b->>'action','deadline',CASE WHEN isfinite(deadline) THEN to_jsonb(deadline) ELSE to_jsonb('until_revoked'::text) END,'member_profile',profile,'authority_kind',CASE WHEN application_use THEN 'application_use' ELSE 'project_work' END,'note','application_personal_record_ownership_must_also_be_respected');
END $$;

DO $test$ DECLARE r jsonb;route text;b jsonb;proof text;
BEGIN
 FOREACH route IN ARRAY ARRAY['/api/v1/sessions/start','/api/v1/sessions/ABCDEFGHIJKLMNOPQRSTUVWX/chunks/seal','/api/v1/sessions/ABCDEFGHIJKLMNOPQRSTUVWX/finish','/api/v1/sessions/00000000000000000000000000000001/seal','/api/v1/sessions/00000000000000000000000000000001/chunks/seal','/api/v1/sessions/00000000000000000000000000000001/upload-complete','/api/v1/sessions/00000000000000000000000000000001/finish','/api/v1/sessions/00000000000000000000000000000001/resume-empty'] LOOP
  b:=jsonb_build_object('application_id','baize','action','write','resource',jsonb_build_object('method','POST','route',route));
  r:=pg_temp.authorization_application_decision('ordinary',b);
  IF r->>'authority_kind'<>'application_use' OR r->>'action'<>'write' OR r->>'actor_id'<>'00000000-0000-0000-0000-000000000010' OR r->>'deadline'<>'until_revoked' THEN RAISE EXCEPTION 'positive_case_failed';END IF;
 END LOOP;
 FOREACH route IN ARRAY ARRAY['/api/v1/preferences/capture-layout','/v2/materials','/api/v1/sessions/start/extra','/api/v1/sessions/start?continuous=true','/api/v1/sessions/../start','/api/v1/sessions/00000000000000000000000000000001/delete'] LOOP
  BEGIN
   PERFORM pg_temp.authorization_application_decision('ordinary',jsonb_build_object('application_id','baize','action','write','resource',jsonb_build_object('method','POST','route',route)));
   RAISE EXCEPTION 'unknown_route_admitted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 END LOOP;
 b:=jsonb_build_object('application_id','baize','action','write','resource',jsonb_build_object('method','POST','route','/api/v1/sessions/start'));
 FOREACH proof IN ARRAY ARRAY['restricted','unmapped','expired'] LOOP
  BEGIN PERFORM pg_temp.authorization_application_decision(proof,b);RAISE EXCEPTION 'invalid_identity_admitted';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 END LOOP;
 BEGIN PERFORM pg_temp.authorization_application_decision('revoked',b);RAISE EXCEPTION 'revoked_admitted';EXCEPTION WHEN invalid_authorization_specification THEN NULL;END;
 BEGIN PERFORM pg_temp.authorization_application_decision('ordinary',jsonb_set(b,'{resource,method}','"DELETE"'));RAISE EXCEPTION 'wrong_method_admitted';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 BEGIN PERFORM pg_temp.authorization_application_decision('ordinary',jsonb_set(b,'{application_id}','"tools"'));RAISE EXCEPTION 'other_app_admitted';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 UPDATE pg_temp.projects SET visibility='private';
 BEGIN PERFORM pg_temp.authorization_application_decision('ordinary',b);RAISE EXCEPTION 'private_project_admitted';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 UPDATE pg_temp.projects SET visibility='team',organization_id='00000000-0000-0000-0000-000000000021';
 BEGIN PERFORM pg_temp.authorization_application_decision('ordinary',b);RAISE EXCEPTION 'cross_org_admitted';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
END $test$;
ROLLBACK;

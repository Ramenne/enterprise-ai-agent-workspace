BEGIN;
CREATE TABLE IF NOT EXISTS authz.confirmed_software_receipts(
 credential_id uuid PRIMARY KEY,actor_id uuid NOT NULL,original_client_id uuid NOT NULL,
 original_credential_id uuid NOT NULL,context_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
REVOKE ALL ON authz.confirmed_software_receipts FROM PUBLIC;
CREATE OR REPLACE FUNCTION authz.authorization_software_issue(proof text,b jsonb,p_key text,p_token_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;primary_i jsonb;c authz.engineering_contexts;pid_text text;acts text[];expiry timestamptz;unlimited boolean;payload jsonb;r jsonb;new_credential authz.credentials;
BEGIN
 i:=authz.authenticate(proof);
 SELECT * INTO c FROM authz.engineering_contexts WHERE actor_id=(i->>'actor_id')::uuid AND client_id=(i->>'client_id')::uuid AND credential_id=(i->>'credential_id')::uuid AND expires_at>clock_timestamp() ORDER BY created_at DESC LIMIT 1;
 IF c.id IS NULL THEN RAISE EXCEPTION 'management_verification_required' USING ERRCODE='42501';END IF;
 primary_i:=authz.authenticate(c.primary_proof);
 IF primary_i->>'actor_id' IS DISTINCT FROM i->>'actor_id' OR primary_i->>'is_primary'<>'true' THEN RAISE EXCEPTION 'same_current_primary_required' USING ERRCODE='42501';END IF;
 IF jsonb_typeof(b->'project_ids')<>'array' OR coalesce(jsonb_array_length(b->'project_ids'),0) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'software_project_scope_required' USING ERRCODE='22023';END IF;
 FOR pid_text IN SELECT jsonb_array_elements_text(b->'project_ids') LOOP
  IF NOT authz.client_resource_allowed745((i->>'client_id')::uuid,pid_text::uuid) OR (c.project_id IS NOT NULL AND c.project_id<>pid_text::uuid) OR NOT EXISTS(SELECT FROM v8.projects WHERE id=pid_text::uuid AND state='active' AND organization_id=(i->>'organization_id')::uuid AND (visibility='team' OR owner_id=(i->>'actor_id')::uuid OR manager_id=(i->>'actor_id')::uuid)) THEN RAISE EXCEPTION 'software_project_scope_expansion' USING ERRCODE='42501';END IF;
 END LOOP;
 SELECT array_agg(DISTINCT x ORDER BY x) INTO acts FROM (SELECT value x FROM jsonb_array_elements_text(i->'client_actions') WHERE value !~ '^hufu[.](credential|qualification|management)' UNION SELECT unnest(ARRAY['resource.read','resource.write','resource.deploy']))a;
 IF coalesce(b->>'profile','resource')='construction_manager' THEN
  IF NOT EXISTS(SELECT FROM authz.principals WHERE id=(i->>'actor_id')::uuid AND active AND role='organization_admin') OR EXISTS(SELECT FROM jsonb_array_elements_text(b->'project_ids') p WHERE NOT authz.engineering_can_manage(proof,p::uuid)) THEN RAISE EXCEPTION 'existing_project_management_source_required' USING ERRCODE='42501';END IF;
  SELECT array_agg(DISTINCT x ORDER BY x) INTO acts FROM unnest(acts||ARRAY['hufu.qualification.manage','hufu.management.delegate','hufu.credential.manage']) x;
 ELSIF coalesce(b->>'profile','resource')<>'resource' THEN RAISE EXCEPTION 'software_profile_invalid' USING ERRCODE='22023';END IF;
 IF NOT acts<@ARRAY(SELECT jsonb_array_elements_text(primary_i->'client_actions')) THEN RAISE EXCEPTION 'primary_software_capability_missing' USING ERRCODE='42501';END IF;
 unlimited:=coalesce((b->>'until_revoked')::boolean,false);
 IF unlimited AND NOT(i->>'until_revoked')::boolean THEN RAISE EXCEPTION 'software_lifetime_expansion' USING ERRCODE='42501';END IF;
 expiry:=CASE WHEN unlimited THEN NULL WHEN b->>'profile'='construction_manager' AND (i->>'until_revoked')::boolean THEN least(clock_timestamp()+interval '24 hours',coalesce((b->>'expires_at')::timestamptz,c.expires_at)) ELSE least(c.expires_at,coalesce((b->>'expires_at')::timestamptz,c.expires_at)) END;
 IF b->>'profile'='construction_manager' AND unlimited THEN RAISE EXCEPTION 'construction_software_requires_expiry' USING ERRCODE='22023';END IF;
 IF (NOT unlimited AND expiry<=clock_timestamp()) OR length(coalesce(b->>'label','')) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'invalid_software_issue' USING ERRCODE='22023';END IF;
 payload:=jsonb_build_object('label',b->>'label','actions',to_jsonb(acts),'resource_selector',jsonb_build_object('version',1,'kind','projects','project_ids',b->'project_ids'),'expires_at',expiry,'until_revoked',unlimited,'token_hash',p_token_hash);
 r:=authz.manage(c.primary_proof,'credential.create',payload,p_key,encode(public.digest(payload::text,'sha256'),'hex'));
 SELECT * INTO new_credential FROM authz.credentials WHERE id=(r->>'credential_id')::uuid;
 UPDATE authz.client_filters745 SET clauses=clauses||coalesce(i->'scope_filters','[]') WHERE client_id=new_credential.client_id AND coalesce(i->'scope_filters','[]')<>'[]';
 INSERT INTO authz.confirmed_software_receipts(credential_id,actor_id,original_client_id,original_credential_id,context_id) VALUES(new_credential.id,(i->>'actor_id')::uuid,(i->>'client_id')::uuid,(i->>'credential_id')::uuid,c.id) ON CONFLICT DO NOTHING;
 INSERT INTO authz.engineering_contexts(actor_id,client_id,credential_id,primary_proof,project_id,authority_source,expires_at,authorized_actions)
 SELECT c.actor_id,new_credential.client_id,new_credential.id,c.primary_proof,c.project_id,c.authority_source,least(expiry,c.expires_at),c.authorized_actions WHERE NOT EXISTS(SELECT FROM authz.engineering_contexts WHERE credential_id=new_credential.id AND expires_at>clock_timestamp());
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details) VALUES((i->>'actor_id')::uuid,(i->>'client_id')::uuid,'authz','software.confirmed_self_issue',new_credential.id,jsonb_build_object('project_ids',b->'project_ids','expires_at',expiry,'until_revoked',unlimited,'qualification_unchanged',true,'original_software_unchanged',true));
 RETURN r||jsonb_build_object('actor_id',i->>'actor_id','actions',to_jsonb(acts),'project_ids',b->'project_ids','expires_at',expiry,'until_revoked',unlimited,'qualification_unchanged',true,'original_software_unchanged',true);
END $$;
CREATE OR REPLACE FUNCTION authz.authorization_software_download(proof text,cid uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;r authz.confirmed_software_receipts;c authz.engineering_contexts;keyrow authz.credentials;
BEGIN
 i:=authz.authenticate(proof);SELECT * INTO r FROM authz.confirmed_software_receipts WHERE credential_id=cid;
 SELECT * INTO c FROM authz.engineering_contexts WHERE actor_id=r.actor_id AND client_id=r.original_client_id AND credential_id=r.original_credential_id AND expires_at>clock_timestamp() ORDER BY created_at DESC LIMIT 1;SELECT * INTO keyrow FROM authz.credentials WHERE id=cid;
 IF r.actor_id IS DISTINCT FROM (i->>'actor_id')::uuid OR r.original_client_id IS DISTINCT FROM (i->>'client_id')::uuid OR r.original_credential_id IS DISTINCT FROM (i->>'credential_id')::uuid OR c.id IS NULL OR keyrow.id IS NULL OR keyrow.revoked_at IS NOT NULL OR (NOT keyrow.until_revoked AND keyrow.expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'same_confirmed_owner_required' USING ERRCODE='42501';END IF;
 PERFORM authz.authenticate(c.primary_proof);
 IF EXISTS(SELECT FROM authz.client_filters745 f, jsonb_array_elements(f.clauses) clause, jsonb_array_elements_text(coalesce(clause->'project_ids','[]')) pid WHERE f.client_id=keyrow.client_id AND NOT authz.client_resource_allowed745((i->>'client_id')::uuid,pid::uuid)) THEN RAISE EXCEPTION 'software_project_scope_expansion' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('state','allowed','credential_id',cid);
END $$;
REVOKE ALL ON FUNCTION authz.authorization_software_issue(text,jsonb,text,text),authz.authorization_software_download(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.authorization_software_issue(text,jsonb,text,text),authz.authorization_software_download(text,uuid) TO hub2_hufu;
-- Restrict any earlier receipt to its already recorded intended project list.
INSERT INTO authz.client_filters745(client_id,clauses)
SELECT cr.client_id,jsonb_build_array(jsonb_build_object('project_ids',a.details->'project_ids'))
FROM authz.confirmed_software_receipts r JOIN authz.credentials cr ON cr.id=r.credential_id
JOIN evidence.audit a ON a.aggregate_id=r.credential_id AND a.action='software.confirmed_self_issue'
WHERE jsonb_typeof(a.details->'project_ids')='array'
ON CONFLICT(client_id) DO UPDATE SET clauses=CASE WHEN authz.client_filters745.clauses @> EXCLUDED.clauses THEN authz.client_filters745.clauses ELSE authz.client_filters745.clauses||EXCLUDED.clauses END;
COMMIT;

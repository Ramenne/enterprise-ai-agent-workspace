-- Additive over actual731+735/736. No subjects, credentials or qualifications seeded.
BEGIN;SET ROLE hub2_authz_owner;
CREATE FUNCTION vault2.may_decide_deadline(i jsonb,e vault2.entries)RETURNS timestamptz LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$
DECLARE p authz.principals;pr v8.projects;q authz.qualifications;root authz.qualifications;deadline timestamptz;best timestamptz;
BEGIN
 -- Existing full manager path remains valid; decide-only never expands it.
 IF EXISTS(SELECT FROM authz.clients WHERE id=(i->>'client_id')::uuid AND active AND 'hufu.credential.manage'=ANY(actions))THEN RETURN vault2.manager_deadline(i,e);END IF;
 BEGIN PERFORM authz.require_client_capability(i,'hufu.vault.decide');EXCEPTION WHEN insufficient_privilege THEN RETURN NULL;END;
 SELECT * INTO p FROM authz.principals WHERE id=(i->>'actor_id')::uuid;SELECT * INTO pr FROM v8.projects WHERE id=e.project_id;
 IF p.active IS DISTINCT FROM true OR pr.state IS DISTINCT FROM'active'OR p.organization_id IS DISTINCT FROM e.organization_id OR pr.organization_id IS DISTINCT FROM e.organization_id THEN RETURN NULL;END IF;
 -- Approver-only access requires a real current credential.manage management qualification.
 -- A legacy role/name/mission/sponsor is not a new grant or a substitute for this fact.
 FOR q IN SELECT * FROM authz.qualifications WHERE principal_id=p.id AND project_id=e.project_id AND 'credential.manage'=ANY(actions)LOOP
  IF authz.management_valid(q.id,p.id,e.project_id)AND authz.selector_matches(q.resource_selector,e.project_id,jsonb_build_object('project_id',e.project_id,'area_id',e.area_id))THEN
   deadline:=CASE WHEN q.until_revoked THEN'infinity'::timestamptz ELSE q.expires_at END;
   IF q.parent_id IS NOT NULL THEN SELECT * INTO root FROM authz.qualifications WHERE id=q.parent_id;deadline:=least(deadline,CASE WHEN root.until_revoked THEN'infinity'::timestamptz ELSE root.expires_at END);END IF;
   IF deadline>clock_timestamp()THEN best:=greatest(best,deadline);END IF;
  END IF;
 END LOOP;RETURN best;
END$$;
CREATE FUNCTION vault2.may_decide(i jsonb,e vault2.entries)RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$SELECT coalesce(vault2.may_decide_deadline(i,e)>clock_timestamp(),false)$$;
REVOKE ALL ON FUNCTION vault2.may_decide_deadline(jsonb,vault2.entries),vault2.may_decide(jsonb,vault2.entries)FROM PUBLIC,hub2_hufu,hub2_mem,hub2_v8,hub2_worker;
-- Only the three relevant existing interfaces change. Registry/rotation/revoke keep manager().

CREATE OR REPLACE FUNCTION vault2.apply(proof text, b jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'vault2'
AS $function$DECLARE i jsonb;e vault2.entries;a vault2.applications;fp text:=encode(public.digest(b::text,'sha256'),'hex');BEGIN
 i:=vault2.identity(proof);PERFORM authz.require_client_capability(i,'hufu.vault.read');SELECT * INTO e FROM vault2.entries WHERE id=vault2.resolve_entry(i,b) FOR SHARE;IF e.id IS NULL OR NOT vault2.visible(i,e)THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 IF coalesce(length(b->>'idempotency_key'),0)NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'invalid_input';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended((i->>'actor_id')||':vaultapply:'||(b->>'idempotency_key'),0));SELECT * INTO a FROM vault2.applications WHERE applicant_id=(i->>'actor_id')::uuid AND idempotency_key=b->>'idempotency_key';
 IF a.id IS NOT NULL THEN IF a.fingerprint IS DISTINCT FROM fp THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505';END IF;ELSE
 INSERT INTO vault2.applications(entry_id,applicant_id,applicant_client_id,idempotency_key,fingerprint,purpose,requested_until_revoked,requested_expires_at)VALUES(e.id,(i->>'actor_id')::uuid,(i->>'client_id')::uuid,b->>'idempotency_key',fp,b->'purpose',coalesce((b->>'until_revoked')::boolean,false),(b->>'expires_at')::timestamptz)RETURNING * INTO a;
 INSERT INTO vault2.audit(actor_id,client_id,action,entry_id,application_id)VALUES((i->>'actor_id')::uuid,(i->>'client_id')::uuid,'apply',e.id,a.id);END IF;
 RETURN jsonb_build_object('state',a.state,'application_id',a.id,'revision',a.revision,'entry_id',e.id,'next_step','authorized_manager_decides');END$function$;

CREATE OR REPLACE FUNCTION vault2.applications(proof text, b jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'vault2'
AS $function$DECLARE i jsonb;items jsonb;BEGIN i:=vault2.identity(proof);
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'entry_id',a.entry_id,'applicant_id',a.applicant_id,'applicant_client_id',a.applicant_client_id,'purpose',a.purpose,'state',a.state,'revision',a.revision,'requested_expires_at',a.requested_expires_at,'requested_until_revoked',a.requested_until_revoked)ORDER BY a.id),'[]')INTO items FROM(SELECT a.* FROM vault2.applications a JOIN vault2.entries e ON e.id=a.entry_id WHERE((b->>'entry_id'IS NULL AND b->>'key'IS NULL)OR e.id=vault2.resolve_entry(i,b))AND((a.applicant_id=(i->>'actor_id')::uuid AND EXISTS(SELECT FROM authz.clients WHERE id=(i->>'client_id')::uuid AND active AND 'hufu.vault.read'=ANY(actions)))OR vault2.may_decide(i,e))AND(coalesce(b->>'state','pending')=a.state)AND(b->>'cursor'IS NULL OR a.id>(b->>'cursor')::uuid)ORDER BY a.id LIMIT 100)a;
 RETURN jsonb_build_object('state','applications','items',items,'next_cursor',CASE WHEN jsonb_array_length(items)=100 THEN items->99->'id'ELSE NULL END,'coverage','bounded_current_scope_page');END$function$;

CREATE OR REPLACE FUNCTION vault2.decide_pre_registry_next(proof text, b jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'vault2'
AS $function$DECLARE i jsonb;e vault2.entries;a vault2.applications;g vault2.grants;result jsonb;old vault2.commands;command_key text:=b->>'idempotency_key';fp text:=encode(public.digest(b::text,'sha256'),'hex');expiry timestamptz;unlimited boolean;ceiling timestamptz;BEGIN
 i:=vault2.identity(proof);SELECT * INTO a FROM vault2.applications WHERE id=(b->>'application_id')::uuid;SELECT * INTO e FROM vault2.entries WHERE id=a.entry_id FOR SHARE;
 i:=authz.vault_current_identity(proof,e.project_id);
 IF b->>'decision'='approve'AND a.applicant_id=(i->>'actor_id')::uuid THEN RAISE EXCEPTION 'self_approval_forbidden' USING ERRCODE='42501';END IF;IF a.id IS NULL OR NOT vault2.may_decide(i,e)THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;IF coalesce(length(command_key),0)NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'invalid_input';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended((i->>'actor_id')||':vaultdecide:'||command_key,0));SELECT * INTO old FROM vault2.commands WHERE actor_id=(i->>'actor_id')::uuid AND vault2.commands.key=command_key;
 i:=authz.vault_current_identity(proof,e.project_id);IF NOT vault2.may_decide(i,e)THEN RAISE EXCEPTION 'current_approver_required' USING ERRCODE='42501';END IF;IF old.key IS NOT NULL THEN IF old.fingerprint IS DISTINCT FROM fp THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505';END IF;RETURN old.result;END IF;
 SELECT * INTO a FROM vault2.applications WHERE id=a.id FOR UPDATE;i:=authz.vault_current_identity(proof,e.project_id);IF NOT vault2.may_decide(i,e)THEN RAISE EXCEPTION 'current_manager_required' USING ERRCODE='42501';END IF;IF a.revision IS DISTINCT FROM(b->>'expected_revision')::bigint OR a.state<>'pending'THEN RAISE EXCEPTION 'revision_conflict' USING ERRCODE='40001';END IF;
 IF b->>'decision'IS NULL OR b->>'decision'NOT IN('approve','reject')THEN RAISE EXCEPTION 'invalid_input';END IF;
 IF b->>'decision'='approve'THEN
  unlimited:=coalesce((b->>'until_revoked')::boolean,a.requested_until_revoked);expiry:=coalesce((b->>'expires_at')::timestamptz,a.requested_expires_at);IF NOT unlimited AND(expiry IS NULL OR expiry<=clock_timestamp())THEN RAISE EXCEPTION 'finite_expiry_or_until_revoked_required';END IF;
  ceiling:=vault2.may_decide_deadline(i,e);IF ceiling IS NULL OR ceiling<=clock_timestamp()THEN RAISE EXCEPTION 'current_approver_required' USING ERRCODE='42501';END IF;ceiling:=least(ceiling,coalesce(e.provider_expires_at,'infinity'::timestamptz));expiry:=least(CASE WHEN unlimited THEN'infinity'::timestamptz ELSE expiry END,ceiling);unlimited:=NOT isfinite(expiry);IF unlimited THEN expiry:=NULL;END IF;
  IF NOT EXISTS(SELECT FROM authz.principals p JOIN authz.clients c ON c.principal_id=p.id WHERE p.id=a.applicant_id AND p.active AND p.organization_id=e.organization_id AND c.id=a.applicant_client_id AND c.active)THEN RAISE EXCEPTION 'current_applicant_required' USING ERRCODE='42501';END IF;
  INSERT INTO vault2.grants(entry_id,principal_id,client_id,issued_by,until_revoked,expires_at,reason)VALUES(e.id,a.applicant_id,a.applicant_client_id,(i->>'actor_id')::uuid,unlimited,expiry,b->'reason')RETURNING * INTO g;
 END IF;
 UPDATE vault2.applications SET state=CASE WHEN b->>'decision'='approve'THEN'approved'ELSE'rejected'END,revision=revision+1,decided_by=(i->>'actor_id')::uuid,grant_id=g.id,decision=b->'reason'WHERE id=a.id RETURNING * INTO a;
 result:=jsonb_build_object('state',a.state,'application_id',a.id,'revision',a.revision,'grant_id',g.id,'entry_id',e.id);
 INSERT INTO vault2.audit(actor_id,client_id,action,entry_id,application_id,grant_id,details)VALUES((i->>'actor_id')::uuid,(i->>'client_id')::uuid,'decide',e.id,a.id,g.id,jsonb_build_object('decision',a.state));INSERT INTO vault2.commands VALUES((i->>'actor_id')::uuid,command_key,fp,result);i:=vault2.identity(proof);IF NOT vault2.may_decide(i,e)THEN RAISE EXCEPTION 'current_manager_required' USING ERRCODE='42501';END IF;RETURN result;
END$function$;

REVOKE ALL ON FUNCTION vault2.decide_pre_registry_next(text,jsonb)FROM PUBLIC,hub2_hufu,hub2_mem,hub2_v8,hub2_worker;
-- The current public decide wrapper already enforces no self-approval, and invokes the private pre.
-- Existing execute grants on apply/applications/public decide remain unchanged.
RESET ROLE;COMMIT;

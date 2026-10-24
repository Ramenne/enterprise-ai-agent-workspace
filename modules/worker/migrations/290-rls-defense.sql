-- Defense against accidental runtime row privileges, not a second Actor/tenant authority model.
-- Business effects still require the existing signed handle, Source, CAS and final clock guards.
DO $rls$
DECLARE owner_role text;runtime_role text;entry record;
BEGIN
 FOREACH owner_role IN ARRAY ARRAY['hub2_authz_owner','hub2_mem_owner','hub2_v8_owner','hub2_evidence_owner'] LOOP
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname=owner_role AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls) THEN RAISE EXCEPTION 'rls_trusted_nologin_owner_required';END IF;
 END LOOP;
 FOREACH runtime_role IN ARRAY ARRAY['hub2_hufu','hub2_mem','hub2_v8','hub2_worker'] LOOP
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname=runtime_role AND rolcanlogin AND NOT rolsuper AND NOT rolbypassrls) THEN RAISE EXCEPTION 'rls_restricted_runtime_required';END IF;
  FOREACH owner_role IN ARRAY ARRAY['hub2_authz_owner','hub2_mem_owner','hub2_v8_owner','hub2_evidence_owner'] LOOP
   IF pg_has_role(runtime_role,owner_role,'MEMBER') THEN RAISE EXCEPTION 'rls_runtime_owner_membership_forbidden';END IF;
  END LOOP;
 END LOOP;
 -- This reviewed schema list covers domain facts, authority, audit/transport evidence and durable job ledger.
 -- No SQL/table grants are added. Cross-domain NOLOGIN capabilities retain only their pre-existing grants.
 FOR entry IN SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner
  WHERE n.nspname IN ('authz','mem','v8','evidence','jobs') AND c.relkind IN ('r','p') AND r.rolname IN ('hub2_authz_owner','hub2_mem_owner','hub2_v8_owner','hub2_evidence_owner') ORDER BY n.nspname,c.relname LOOP
  EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',entry.nspname,entry.relname);
  EXECUTE format('CREATE POLICY guarded_domain_owner_access ON %I.%I FOR ALL TO hub2_authz_owner,hub2_mem_owner,hub2_v8_owner,hub2_evidence_owner USING (true) WITH CHECK (true)',entry.nspname,entry.relname);
 END LOOP;
 -- No FORCE RLS: owners normally bypass their own tables; superuser/BYPASSRLS remain explicit trust boundaries.
 -- authn four BetterAuth tables retain hub2_hufu standard CRUD and authenticated account/session fences.
 -- worker_queue retains legitimate pg-boss direct operation. coord.schema_migrations retains deployment registry access.
 -- Those schemas are purposefully outside this deny-by-default runtime domain-data fence.
END $rls$;

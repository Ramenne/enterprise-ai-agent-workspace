-- Narrow the ONE actual issued child whose obsolete top-level project_ids
-- field was ignored by the existing API. Preserve key, parent and receipt.
BEGIN;
SET LOCAL ROLE hub2_authz_owner;
DO $check$ BEGIN
 IF NOT EXISTS(SELECT FROM authz.clients c JOIN authz.credentials k ON k.client_id=c.id WHERE c.id='0b5c01f9-bd80-443b-ae60-455ebed7ee0f'AND c.principal_id='9567d1c6-ae3c-4ee9-a9cd-55e83bd697f3'AND c.active AND c.actions=ARRAY['hufu.baize.members.read']AND k.id='41f8028b-2f99-4209-ad60-b41ec5d33060'AND k.parent_credential_id='035360c8-6dec-4456-a138-cbb41746f7b6'AND authz.family_valid(k.id))THEN RAISE EXCEPTION 'actual_issued_baize_child_required';END IF;
END $check$;
INSERT INTO authz.client_filters745(client_id,clauses)VALUES('0b5c01f9-bd80-443b-ae60-455ebed7ee0f','[{"project_ids":["3527ac31-0643-4f89-a6bd-b1e9768b2e42"]}]')ON CONFLICT(client_id)DO NOTHING;
DO $check$ BEGIN
 IF NOT EXISTS(SELECT FROM authz.client_filters745 WHERE client_id='0b5c01f9-bd80-443b-ae60-455ebed7ee0f'AND clauses='[{"project_ids":["3527ac31-0643-4f89-a6bd-b1e9768b2e42"]}]'::jsonb)THEN RAISE EXCEPTION 'fixed_baize_child_filter_required';END IF;
END $check$;
COMMIT;

-- Fixed registered-target metadata only; original table owner is postgres.
-- No direct application_targets/schema grant to the nested NOLOGIN caller.
BEGIN;
CREATE OR REPLACE VIEW authz.baize_directory_registered_target WITH(security_barrier=true) AS
 SELECT application_id,project_id,active FROM authz.application_targets
 WHERE application_id='baize' AND project_id='3527ac31-0643-4f89-a6bd-b1e9768b2e42'::uuid;
ALTER VIEW authz.baize_directory_registered_target OWNER TO postgres;
REVOKE ALL ON authz.baize_directory_registered_target FROM PUBLIC,hub2_hufu,hub2_mem,hub2_v8,hub2_worker;
GRANT SELECT ON authz.baize_directory_registered_target TO hub2_authz_owner;
COMMIT;

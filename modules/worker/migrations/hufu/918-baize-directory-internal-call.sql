-- The historical authorization function is owned by postgres and grants only
-- the Hufu runtime direct execution. This new nested caller is the existing
-- NOLOGIN authz owner; preserve PUBLIC/runtime boundaries and all authority SQL.
BEGIN;
GRANT EXECUTE ON FUNCTION authz.authorization_application_decision(text,jsonb) TO hub2_authz_owner;
COMMIT;

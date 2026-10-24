BEGIN; SET ROLE hub2_authz_owner;
CREATE FUNCTION vault2.delivery_request_deadline(d vault2.delivery_items) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$
 SELECT CASE WHEN d.request_id IS NULL THEN d.expires_at ELSE least(d.expires_at,(SELECT approved_until FROM vault2.delivery_requests WHERE id=d.request_id AND state='approved')) END
$$;
REVOKE ALL ON FUNCTION vault2.delivery_request_deadline(vault2.delivery_items) FROM PUBLIC;
DO $deadline$ DECLARE name text;s text; BEGIN
 FOREACH name IN ARRAY ARRAY['delivery_list(text)','delivery_prepare(text,jsonb)','delivery_verify(text,jsonb)'] LOOP
 s:=pg_get_functiondef(('vault2.'||name)::regprocedure);
 IF name='delivery_list(text)' THEN s:=replace(s,$old$'expires_at',expires_at$old$,$new$'expires_at',vault2.delivery_request_deadline(delivery_items)$new$);
 ELSE s:=replace(s,'least(d.expires_at,clock_timestamp()','least(vault2.delivery_request_deadline(d),clock_timestamp()'); END IF;
 EXECUTE s;
 END LOOP;
END $deadline$;
RESET ROLE;COMMIT;

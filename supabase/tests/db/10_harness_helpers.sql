-- Harness helpers (NOT part of the app). Lives in its own schema.
CREATE SCHEMA IF NOT EXISTS harness;
GRANT USAGE ON SCHEMA harness TO anon, authenticated;

-- Simulate a PostgREST request JWT for the given user.
CREATE OR REPLACE FUNCTION harness.login(p_sub UUID, p_email TEXT DEFAULT NULL)
RETURNS TEXT LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
    json_build_object('sub', p_sub, 'role', 'authenticated', 'email', p_email)::text, false);
$$;
CREATE OR REPLACE FUNCTION harness.logout()
RETURNS TEXT LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', '', false);
$$;

CREATE TABLE IF NOT EXISTS harness.results (
  n     SERIAL PRIMARY KEY,
  label TEXT,
  pass  BOOLEAN,
  info  TEXT
);
GRANT ALL ON harness.results TO anon, authenticated;
GRANT ALL ON SEQUENCE harness.results_n_seq TO anon, authenticated;

CREATE OR REPLACE FUNCTION harness.ok(p_label TEXT, p_cond BOOLEAN, p_info TEXT DEFAULT NULL)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO harness.results(label, pass, info) VALUES (p_label, COALESCE(p_cond, false), p_info);
  RETURN CASE WHEN COALESCE(p_cond, false) THEN 'PASS ' ELSE 'FAIL ' END || p_label || COALESCE(' :: ' || p_info, '');
END $$;

-- Run a SQL statement (in the CURRENT role / JWT) and capture error text.
-- Returns 'OK: <result>' or 'ERR <sqlstate>: <message>'.
CREATE OR REPLACE FUNCTION harness.try(p_sql TEXT)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE r TEXT;
BEGIN
  EXECUTE p_sql INTO r;
  SET CONSTRAINTS ALL IMMEDIATE;   -- surface deferred constraint/trigger errors (as COMMIT would)
  RETURN 'OK: ' || COALESCE(r, '<null>');
EXCEPTION WHEN OTHERS THEN
  RETURN 'ERR ' || SQLSTATE || ': ' || SQLERRM;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA harness TO anon, authenticated;

-- Like try() but also forces deferred constraints/triggers (what COMMIT would do).
CREATE OR REPLACE FUNCTION harness.try_commit(p_sql TEXT)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE r TEXT;
BEGIN
  EXECUTE p_sql INTO r;
  SET CONSTRAINTS ALL IMMEDIATE;
  RETURN 'OK: ' || COALESCE(r, '<null>');
EXCEPTION WHEN OTHERS THEN
  RETURN 'ERR ' || SQLSTATE || ': ' || SQLERRM;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA harness TO anon, authenticated;

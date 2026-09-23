-- Minimal Supabase platform shim for running the gbig-app migrations on
-- vanilla PostgreSQL 16. Mirrors the parts of a Supabase project that the
-- migrations / client depend on: API roles, default grants, auth schema
-- helpers, auth.users.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator LOGIN NOINHERIT;
  END IF;
END $$;

GRANT anon, authenticated, service_role TO authenticator;
GRANT anon, authenticated, service_role TO postgres;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── auth schema ─────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email              TEXT,
  raw_user_meta_data JSONB,
  created_at         TIMESTAMPTZ DEFAULT now()
);

CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.sub', true), ''),
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;

CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
  )::text
$$;

CREATE OR REPLACE FUNCTION auth.email() RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.email', true), ''),
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email'
  )::text
$$;

CREATE OR REPLACE FUNCTION auth.jwt() RETURNS JSONB
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim', true), ''),
    NULLIF(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon, authenticated, service_role;
GRANT ALL ON auth.users TO service_role;

-- ── public schema default privileges (Supabase defaults) ─────────────────────
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES    IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES    TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;

-- Supabase ships a realtime publication; harmless if unused.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END $$;

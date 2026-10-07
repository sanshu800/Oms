-- Runs automatically on first container init (docker-entrypoint-initdb.d).
-- Creates the restricted role the running application actually
-- connects as (APP_DATABASE_URL) — separate from the superuser
-- POSTGRES_USER, which owns the schema and is reserved for migrations.
--
-- Row-Level Security policies are unconditionally bypassed by
-- superusers no matter how they're configured — the app MUST connect
-- as a non-superuser, non-BYPASSRLS role for RLS to do anything.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'techmart_app') THEN
    CREATE ROLE techmart_app LOGIN PASSWORD 'techmart_app_dev_password' NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO techmart_app;

-- Tables created later by `prisma migrate deploy` don't exist yet at
-- init time — these DEFAULT PRIVILEGES apply automatically to every
-- table/sequence created from this point on, so no manual re-grant is
-- needed after each migration.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO techmart_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON SEQUENCES TO techmart_app;

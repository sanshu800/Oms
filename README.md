# TechMart Platform

The multi-tenant, read-only operations-control foundation for TechMart.

## Week 1 scope

- TypeScript/NestJS API boundary.
- PostgreSQL tenant and store isolation model.
- Redis-backed background-worker boundary.
- Immutable, idempotent Shopify webhook event ledger.
- Docker-based local development environment.

Native OMS order and inventory workflows deliberately do not live here. This service observes connected stores; it does not write to Shopify.

## Local startup

1. Copy `.env.example` to `.env` and replace every secret.
2. Run `docker compose up -d postgres redis` — on first run this also provisions the restricted `techmart_app` database role that the application connects as (see `docker/postgres-init/`); if you're re-pointing at an existing Postgres volume created before this existed, run that same SQL file manually against it once.
3. Run `npm install`, then `npm run db:generate` and `npm run db:migrate`.
4. Run `npm run start:dev`.

The API exposes `GET /health`. Every `/ai/*` and `/oms/exceptions/*` endpoint requires `Authorization: Bearer <tenant API key>` — a key is issued automatically the first time a shop installs, shown once on the OAuth callback success page, or can be minted manually via `src/scripts/create-tenant-api-key.ts`.

## Tenant boundary

Every business record uses both `tenantId` and `storeId`, enforced two ways:

- **Application code**: the authenticated API key resolves `tenantId` server-side (`TenantApiKeyGuard`) — it is never accepted as a client-supplied query/body value on protected endpoints.
- **Database-level row-level security**: every tenant-scoped table has an RLS policy (`prisma/migrations/*_enable_row_level_security`), enforced via `FORCE ROW LEVEL SECURITY` and an ambient session variable set per-request/job (`src/prisma/tenant-context.ts`, `PrismaService`'s query extension). This is real, independent enforcement — even a query that "forgot" to filter by `tenantId` is blocked by Postgres itself, not just the application's own diligence.

This only works because the app connects as `techmart_app` (`APP_DATABASE_URL`), a non-superuser, non-`BYPASSRLS` role — Postgres unconditionally exempts superusers from RLS, so the migration-owning role (`DATABASE_URL`, `techmart`) must never be what the running application queries through. A handful of legitimately cross-tenant operations (resolving a store by Shopify shop domain during webhook/OAuth handling, tenant provisioning itself) explicitly opt out via `prisma.runAsSystem(...)` — everything else defaults to denied, not allowed.

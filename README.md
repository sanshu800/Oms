# TechMart OMS

A Shopify-first, multi-tenant order and operations management platform. The repository contains a NestJS API, PostgreSQL/Prisma data layer, Redis/BullMQ workers, AI-assisted exception handling, and a Next.js dashboard with operational order and inventory views. Shopify create/update/cancel events feed the order lifecycle and inventory reservation ledger.

## Stack

- **API:** TypeScript, NestJS, Fastify
- **Persistence:** PostgreSQL 17, Prisma ORM (CLI and client pinned to the same version)
- **Jobs:** Redis 7 and BullMQ
- **Dashboard:** Next.js 15 / React 19
- **Shopify / AI:** Shopify OAuth and webhooks; Groq investigations are optional in local development

## Local development

Requirements: Node.js 22–24, npm, and Docker Compose.

1. Copy `.env.example` to `.env`. The example is configured for the local Docker services and restricted runtime database role.
2. Start PostgreSQL and Redis:

   ```sh
   docker compose up -d postgres redis
   ```

   On a new Postgres volume, the init script creates the `techmart_app` runtime role. If you already have a volume from before that role existed, apply `docker/postgres-init/01-create-app-role.sql` once as the database owner.

3. Install dependencies and prepare the generated Prisma client:

   ```sh
   npm ci
   npm run db:generate
   npm run db:migrate
   ```

   `npm run build`, `npm run test`, and `npm run start:dev` also generate the Prisma client automatically before running. The explicit `db:generate` command is useful after changing `prisma/schema.prisma`. No engine binary download is involved; see "Prisma without downloaded engine binaries" below.

4. Start the API:

   ```sh
   npm run start:dev
   ```

   The API listens on `http://localhost:4000`; `GET /health` is the basic health check.

5. Optionally run the dashboard in another terminal:

   ```sh
   cd dashboard
   npm ci
   API_SERVER_URL=http://localhost:4000 npm run dev
   ```

### Environment notes

- `DATABASE_URL` is for schema migrations and must use the database-owner account.
- `APP_DATABASE_URL` is the API's runtime connection and should use the restricted, non-superuser `techmart_app` account. This is required for PostgreSQL row-level security (RLS) to protect tenant data. The local example contains the credentials created by Docker Compose.
- `REDIS_URL` is the connection used by BullMQ. It accepts `redis://` and `rediss://` URLs, including credentials and a database index.
- Shopify credentials and `GROQ_API_KEY` may be blank in development/test so the API and unit tests can start without external accounts. Shopify OAuth/webhooks and AI investigations need their respective credentials. Production validation requires these integration credentials and `APP_DATABASE_URL`.
- `APP_URL` is the externally reachable **API** origin; Shopify subscriptions are registered against `<APP_URL>/webhooks/shopify`. It must be stable per environment — see "Hosting and Shopify connectivity" below. It is not the dashboard's address: the dashboard is host-agnostic and needs no URL variable.
- `APP_DOMAIN` is the registrable domain `APP_URL` lives under (for example `reygent.com`). It is required in production, enforced for any environment where it is set, and used by the webhook registration script to recognise this app's subscriptions on a store.
- `WEBHOOK_ENQUEUE_TIMEOUT_MS` bounds how long the API waits for the queue while accepting a delivery (default 4000ms, under Shopify's 5s limit). The delivery is stored first; if queueing fails it is marked FAILED with the reason and the API answers 503 so Shopify retries.
- The dashboard proxies browser calls through same-origin `/api/*` routes. Set `API_SERVER_URL` in `dashboard/.env.local` or the dashboard process environment to the API origin; do not point browser code directly at a localhost URL.

### Hosting and Shopify connectivity

Shopify pushes webhooks to a URI that is stored **on Shopify's side**, per store — not per environment, and not per developer. Two consequences shape how this app is hosted:

- A URI that stops responding is retried for roughly 48 hours and then **deleted**, so a dead tunnel becomes "we silently stopped receiving orders".
- Pointing a development tunnel at a store that production also uses re-registers the *live* store's webhooks to a laptop.

Environment plan (subdomains under `APP_DOMAIN`):

| Environment | You browse | `APP_URL` (API) | Shopify store | How webhooks arrive |
| --- | --- | --- | --- | --- |
| Local development | `http://localhost:3000` | `http://localhost:4000` | dev store only | replayed locally (no tunnel needed) |
| Development on `reygent.com` | `oms.reygent.com` | `https://oms.reygent.com` (same host; the dashboard forwards `/webhooks/*`) | dedicated dev app + dev store | tunnel → dashboard → API |
| Staging | `oms-staging.reygent.com` | `https://api-staging.reygent.com` | staging store | real deployment |
| Production | `app.reygent.com` | `https://api.reygent.com` | merchant stores | real deployment |

`APP_DOMAIN=reygent.com` in every case where a domain host is used; it is the
registrable domain `APP_URL` must live under, not a route. In production the
API keeps its own host deliberately — a frontend deploy must not be able to
take webhook intake down with it. `docs/SHOPIFY-CONNECT.md` has the full
"Hosts and origins" table plus the Cloudflare Tunnel walkthrough.

Rules that follow from that, and are enforced in code:

- **No tunnel in staging or production.** `validateEnvironment` rejects an `APP_URL` that is not `https`, is a tunnel host, is local, or is outside `APP_DOMAIN`. Environment validation fails fast at boot rather than at the first delivery.
- **Tunnels are dev-only and explicit.** The registration script refuses a tunnel `APP_URL` unless `--allow-tunnel` is passed, and production rules are never overridable.
- **Local development uses replay, not tunnels.** `fixtures/shopify-webhooks/` holds real-shaped payloads; the replay tool signs them exactly like Shopify does.

```sh
# 1. Register (or repair) this environment's subscriptions on the store.
npx ts-node shopify-register-orders-webhook.ts --shop=techmart-lab.myshopify.com --dry-run

# 2. Deliver a signed fixture to a locally running API.
npx ts-node replay-shopify-webhook.ts \
  --topic=orders/create --fixture=fixtures/shopify-webhooks/orders-create.json

# 3. Re-send a delivery that is already stored in the database.
npx ts-node replay-shopify-webhook.ts --from-event=<webhookEventId>
```

**Connecting a real store is a documented, step-by-step procedure:** see
[`docs/SHOPIFY-CONNECT.md`](docs/SHOPIFY-CONNECT.md) for the OAuth app install
route (multi-tenant) and the custom-app-token route (single store), webhook
registration, verification, and a troubleshooting table. The two commands at
the centre of it:

```sh
# Route B: one store, Admin API token from a Shopify custom app.
#   --webhook-secret is the app's API secret key; it verifies that store's
#   deliveries, so a second custom app cannot silently invalidate the first.
npx ts-node connect-shopify-store.ts --shop=<shop>.myshopify.com \
  --token=shpat_… --webhook-secret=<api secret key> --dry-run

# Either route: is the stored token still valid, and what may we read with it?
npx ts-node verify-shopify-store-token.ts --shop=<shop>.myshopify.com

# Before real orders arrive: an order reserves stock by looking the line
# item's SKU up in this tenant's inventory catalogue. A freshly connected
# store has no such rows, so map them (audited; --list shows the gaps).
npx ts-node map-shopify-sku.ts --shop=<shop>.myshopify.com --list
npx ts-node map-shopify-sku.ts --shop=<shop>.myshopify.com \
  --sku=TSHIRT-BLACK-M --name="Black Tee (M)" --qty=25
```

The registration script **reconciles** rather than appends: it creates missing topics, moves subscriptions that are ours (same host, another host on `APP_DOMAIN`, or a leftover tunnel URI) onto the current `APP_URL`, removes duplicate registrations of that URI, and never touches a subscription belonging to another integration — those are reported as `unmanaged`.

Intake guarantees (see `src/webhooks/webhook-intake.service.ts`): the delivery is stored before it is acknowledged, queueing is deadline-bounded, a duplicate delivery of an already-processed event is acknowledged without re-queueing, a previously FAILED delivery is reset and re-queued (clearing its stale BullMQ job first), and the payload plus failure reason stay queryable in `WebhookEvent` for replay. A wedged `PROCESSING` event (worker died mid-run) is not re-queued automatically yet — that is the stuck-event runbook and a Phase 0 work item.

Note that the replay tool's default event id is derived from the payload, so replaying the same fixture twice deliberately exercises the duplicate-delivery path instead of creating a second order.

### Prisma without downloaded engine binaries

The CLI and the generated client are both configured to run without Prisma's native Rust engines, so `prisma generate`, `prisma validate`, and `prisma migrate` work with nothing but npm-registry access (including in air-gapped CI):

- `prisma/schema.prisma` generates the client with `engineType = "client"`, so queries go through Prisma's WASM query compiler plus the `pg` driver.
- `prisma.config.ts` selects the JavaScript schema engine (`engine: "js"`) and hands it the same driver adapter, so migrations never look for a `schema-engine` binary.
- `src/prisma/prisma.service.ts` (runtime, restricted `APP_DATABASE_URL` role) and the scripts in `src/scripts/` and the repo root (admin, `DATABASE_URL` owner role) all build their client through `src/prisma/prisma-adapter.ts`.

Unit tests mock `@prisma/client`, so the mock's enum values are generated from
`prisma/schema.prisma` rather than hand-maintained: `npm run test-utils:sync`
rewrites them and `npm run test-utils:check` fails if they are stale. A missing
enum makes every comparison against it `undefined` instead of throwing — a
silent wrong branch, which is how a missing `StoreConnectionStatus` once made
every store look disconnected.

Two details are easy to trip over:

- `npm ci` runs `patch-package`, which applies `patches/@prisma+adapter-pg+6.19.3.patch`. It teaches `@prisma/adapter-pg@6.19.3` to report PostgreSQL's internal `name` type (OID 19) as text; the JavaScript schema engine reads `current_schema()`/`current_database()` while initialising migration bookkeeping, and without the mapping migrations fail with `UnsupportedNativeDataType`. Upstream added this mapping in Prisma 7, so the patch can be deleted as part of that upgrade.
- The datasource block still declares `url = env("DATABASE_URL")` even though the connection comes from the driver adapter, because Prisma 6.x cannot resolve a schema without it — and when schema resolution fails the CLI silently falls back to the native-engine path that needs `binaries.prisma.sh`. Prisma therefore prints a "the values from your schema will NOT be used" warning during CLI commands; it is expected.

The application and CLI use the exact Prisma versions pinned in `package.json`/`package-lock.json` to keep the generated client in sync with the schema.

## Roadmap

`docs/ROADMAP.md` is the canonical plan for turning this Shopify-first slice
into a production-ready SaaS OMS. It records the current capability baseline,
the architecture invariants, and six gated phases: **0)** foundation hardening
(CI, DB-backed integration tests, staging, runbooks), **1)** complete the
operations core for one channel (fulfilment with channel write-back, returns
and refunds, purchasing and receiving, transfers, cycle counts, reconciliation,
operator UI), **2)** multi-channel (connector contract, Shopify refactor behind
it, Amazon, WooCommerce, eBay, cross-channel allocation policy), **3)** the SaaS
layer (accounts, RBAC, self-serve onboarding, billing and quotas, admin console,
tenant lifecycle and compliance), **4)** production readiness at scale
(observability, SLOs, DR and load drills, security engineering), and **5)** the
AI intelligence layer — insights, diagnosis, simulated proposals, then bounded
autonomy that acts only through the same audited service methods humans use.

The ordering is deliberate: operations must be trustworthy before AI is allowed
to reason over them, and each AI capability level ships only after the previous
one has run in production with clean evaluations.

## Tenant boundary

Every tenant-scoped record is protected in two ways:

- **Application layer:** `TenantApiKeyGuard` resolves the tenant from a hashed API key. Protected controllers use that server-resolved tenant ID rather than trusting a client-supplied tenant ID.
- **Database layer:** tenant-scoped tables use PostgreSQL row-level security policies with `FORCE ROW LEVEL SECURITY`. `PrismaService` stamps the authenticated tenant into the database session for each request/job. A small number of cross-tenant operations (such as resolving an incoming Shopify shop domain) explicitly use `prisma.runAsSystem(...)`.

RLS only works when the running application connects as a non-superuser, non-`BYPASSRLS` role. Keep the migration-owner `DATABASE_URL` separate from the restricted runtime `APP_DATABASE_URL`.

## Current product surface

The API exposes tenant/store identity, Shopify install and webhook endpoints, exception workflows, AI investigation/proposal endpoints, and tenant/store-scoped order and inventory reads:

- `GET /oms/orders?storeId=...` supports status, date, and pagination filters; `GET /oms/orders/:orderId?storeId=...` returns line items, reservation history, and fulfillment/shipment details.
- `GET /oms/inventory?storeId=...` supports SKU/name search and pagination; `GET /oms/inventory/:sku?storeId=...` returns balances by location and store-specific external references.
- Every `/oms/orders/*` and `/oms/inventory/*` request requires `Authorization: Bearer <tenant API key>` and is restricted using the authenticated tenant plus the requested store.

Shopify `orders/create`, `orders/updated`, and `orders/cancelled` events are idempotently synced. Line items are joined to the inventory ledger by **SKU**; a SKU with no catalogue row is not guessed at — the order is stored as `FAILED` with a HIGH `ORDER_OPERATIONAL_RISK` exception, and `map-shopify-sku.ts` is the operator command that closes the gap. `shopify-register-orders-webhook.ts` registers all three topics at the configured webhook URI. Pre-fulfillment line changes release and reconcile active reservations; cancellation releases active reservations. Committed/shipped stock is not automatically restored when a later cancellation arrives. The dashboard provides order lifecycle/detail and inventory/location views alongside exceptions, proposals, autonomy, and settings.

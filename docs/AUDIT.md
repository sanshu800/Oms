# Full Project Audit — TechMart OMS

**Date:** 2026-10-08 · **Branch:** `arena/017dc6c2-oms` (from `main` @ `98bbb29`) · **Auditor:** Arena.ai Agent Mode

This is a full-repository audit: architecture, security, data layer, business logic, AI
layer, tests/tooling, and repo hygiene. Every claim marked **verified** was checked by
running code or reading the exact implementation, not inferred from documentation.

---

## 1. Executive summary

TechMart OMS is a Shopify-first, multi-tenant order/operations management platform:
NestJS 11 + Fastify API, PostgreSQL 17 + Prisma 6.19 (Rust-free driver-adapter mode),
Redis 7 + BullMQ workers, a Next.js 15 / React 19 dashboard, and an AI investigation /
bounded-autonomy layer on Groq. ~11.9k LOC of API source, ~5.8k LOC of tests, ~2.9k LOC
of dashboard, a 1,232-line Prisma schema (~30 models, 17 enums), 14 migrations.

**Verdict: unusually well-engineered for this stage, with security and tenancy designed
in depth — but it is a foundation, not a product.** The repository is honest about this:
`docs/ROADMAP.md` states its own gaps (no CI, no DB-backed tests, no RBAC, no returns/
purchasing) instead of hiding them. The audit findings below separate *correctness risks
in what exists* from *missing capability* the roadmap already plans.

### Verification results (run during this audit)

| Check | Result |
| --- | --- |
| Unit tests (`vitest run`, 32 files) | **201 / 201 pass** ✅ (see §7 for sandbox caveat) |
| ESLint (`src/**/*.ts`) | **0 errors, 5 warnings** (unused imports) ✅ |
| TypeScript `tsc --noEmit` (API) | **0 errors** ✅ |
| TypeScript `tsc --noEmit` (dashboard) | **0 errors** ✅ |
| `nest build` | **succeeds** ✅ |
| `npm run test-utils:check` (mock-enum drift guard) | **in sync (17 enums)** ✅ |
| Secret scan (working tree + history) | **no real credentials found** ✅ (docs use `shpat_…` placeholders only) |
| XSS sinks (`dangerouslySetInnerHTML`, `eval`) in dashboard | **none** ✅ |

---

## 2. Architecture overview

```
Shopify ──webhooks──► Fastify API (NestJS, :4000)
                        │  HMAC verify (per-store secret, AES-256-GCM at rest)
                        │  persist-before-ack → WebhookEvent
                        ▼
                    BullMQ (Redis) ──► WebhookWorker ──► WebhookProcessor
                        │                                  │
                        │                     OrderService (idempotent upsert,
                        │                     state machine, reservation reconcile)
                        ▼                                  ▼
                    PostgreSQL 17  ◄────────────  Inventory ledger (allocation,
                    (RLS + FORCE)                  movements, reservations)
                        ▲
     TenantApiKeyGuard + TenantRlsInterceptor (AsyncLocalStorage)
                        ▲
     Dashboard (Next.js :3000, same-origin /api/* proxy) ── Bearer tmk_… key

     AI layer: AiInvestigation (read-only tools) → AiDecisionProposal
               → human approve OR AiAutonomyPolicy (LOW-risk only, throttled)
               → ActionAdapter (Shopify write-back) + verify()
```

Module map (`src/`): `webhooks/` (intake, processor, HMAC), `oms/` (order, inventory,
fulfillment, exception, resolution, risk, investigation, audit), `auth/` (API keys, RLS
interceptor), `prisma/` (RLS-aware client), `queue/` (BullMQ), `shopify/` (OAuth, token
crypto, inventory sync, webhook registration), `ai/` (investigation, decision, autonomy,
actuation, memory, tools, Groq client), `config/` (Zod environment validation).

---

## 3. Security audit

### 3.1 Tenant isolation — defense in depth (excellent) ✅

Verified in `src/auth/`, `src/prisma/prisma.service.ts`,
`prisma/migrations/20260822161416_enable_row_level_security/`:

1. **Application layer.** `TenantApiKeyGuard` resolves `tenantId` only from a Bearer
   key (`tmk_` + 32 random bytes, stored as SHA-256 hash; revoked keys rejected).
   Client-supplied `tenantId` params are ignored by contract.
2. **Database layer.** Every tenant table has `ENABLE` + `FORCE ROW LEVEL SECURITY`
   with `USING`/`WITH CHECK` policies driven by `app.tenant_id` / `app.bypass_rls`
   session settings. Child tables (OrderItem, ShipmentItem, AiToolCall…) use
   `EXISTS` policies through their parent — verified, correct.
3. **Fail-closed.** With no session vars set, `current_setting(..., true)` returns
   NULL and the policy denies — an unscoped query sees nothing, not everything.
   *Verified against the policy SQL semantics.*
4. **Session stamping** is automatic: the Prisma `$extends` interception wraps every
   model operation in a transaction that sets the session vars, and reuses an already-
   open transaction (registered via AsyncLocalStorage) instead of nesting a second one.
   The `redirectedToTx` marker prevents a re-dispatch recursion that previously OOM'd
   the process (documented in code + ROADMAP).
5. **Cross-tenant escapes** (`runAsSystem`) are explicit and narrowly used: webhook
   shop-domain resolution, API-key lookup, webhook claim, tenant provisioning.

**Findings:**

- **S-1 (Medium).** `APP_DATABASE_URL` is optional and falls back to `DATABASE_URL`
  (the migration-owner role). Postgres exempts superusers/owners from RLS even with
  `FORCE`, so a deployment that forgets `APP_DATABASE_URL` runs with *no* effective
  tenant isolation and nothing says so. Add a boot-time warning/health flag
  (`SELECT current_user, rolsuper, rolbypassrls`) and consider refusing to start in
  production when the runtime role is superuser/`BYPASSRLS`.
- **S-2 (Low).** `runAsSystem` bypass is not audit-logged at the data layer. Each
  call site does its own audit writes, but a single `AuditEvent` (or a Postgres log
  hook) whenever `app.bypass_rls` is set would make the bypass surface reviewable.

### 3.2 Webhook authentication (excellent) ✅

Verified in `src/webhooks/shopify-signature.ts`, `webhook-intake.service.ts`,
`shopify.controller.ts`:

- HMAC-SHA256 over the **raw body** with `timingSafeEqual` and length pre-check.
- **Per-store secret** (AES-256-GCM encrypted at rest, `iv.tag.ciphertext`
  base64url format) with deliberate no-fallback semantics on mismatch; environment
  secret only when a store has none stored. Unknown shops are rejected *before* any
  payload is persisted, so unauthenticated data never becomes replayable work.
- Persist-before-ack, bounded enqueue (`WEBHOOK_ENQUEUE_TIMEOUT_MS` < Shopify's 5s),
  503 + `FAILED` marking so Shopify retries; duplicate deliveries ack without
  re-queue; failed deliveries reset and re-queued with stale BullMQ jobs cleared.

**Findings:**

- **S-3 (Medium, known/documented).** A `PROCESSING` event whose worker dies mid-run
  is never reclaimed (no reaper/cron). The README names this as a Phase 0 runbook item;
  it is still a real stuck-work risk today. BullMQ retries cover job crashes *before*
  claim-marking, but the claim-then-crash window leaves the row wedged.

### 3.3 Secrets handling ✅

- Shopify access tokens and webhook secrets: AES-256-GCM with random 12-byte IV and
  auth tag (`shopify-auth.crypto.ts`) — verified correct (key derived as SHA-256 of the
  configured secret; acceptable, standard for a single-tenant-of-config key).
- OAuth `state`: HMAC-signed payload with nonce + expiry (10 min), timing-safe verify,
  shop binding — verified correct.
- API keys: high-entropy random, only hashed at rest; raw shown once. SHA-256 (not
  bcrypt) is appropriate here because keys are 256-bit random (no dictionary attack).
- `.gitignore` covers `.env*`; no real credentials in tree or history (scanned).
- `.env.example` and `docker-compose.yml` contain dev-only passwords — expected.

**Findings:**

- **S-4 (Low).** `connect-shopify-store.ts --token=shpat_…` takes the Admin API token
  as a CLI argument, which leaks into shell history and `ps` output. Support
  `--token-file` / stdin / env var and warn on argv. (Docs do say the token is shown
  once by Shopify, but the leak vector is ours.)

### 3.4 Dashboard / browser security

- Same-origin proxy (`/api/*` rewrites to `API_SERVER_URL`, server-side only) — the
  browser never talks to another origin; no CORS reliance from the browser. ✅
- No `dangerouslySetInnerHTML` / `eval` / `new Function` anywhere in dashboard. ✅
- Auth is Bearer API key in `localStorage` (`techmart_api_key`).

**Findings:**

- **S-5 (Medium, accepted tradeoff today).** A key in `localStorage` is readable by any
  XSS and is a full-tenant credential (the only credential that exists). There are no
  XSS sinks today and the API is machine-auth by design, but before SaaS launch (Phase 3:
  user accounts/RBAC) this must become cookie sessions with HttpOnly+SameSite and CSRF
  protection, or at minimum short-lived scoped tokens.
- **S-6 (Low).** API CORS `origin: true` reflects any request origin. Bearer-token auth
  means no CSRF exposure, but reflecting every origin is broader than needed; consider an
  allowlist from `APP_DOMAIN`.

### 3.5 Input validation

Global `ValidationPipe({ transform, whitelist, forbidNonWhitelisted })` — unknown body
fields are rejected, not ignored. ✅ Zod `validateEnvironment` enforces production
hardness (https, no tunnel hosts, `APP_DOMAIN` containment, required integration
secrets). ✅ (Verified in `src/config/environment.ts`; well-tested.)

---

## 4. Data layer & business logic

### 4.1 Inventory allocation (good, concurrency-aware) ✅

`allocation.service.ts` — verified: Serializable transactions with retry
(`withSerializableRetry`, 3 attempts), conditional `updateMany` with
`availableQty >= qty` guard checked via `updated.count === 1`, movement-ledger writes
for every reservation, single-location preference → largest-first split fallback,
idempotent re-reservation (existing ACTIVE/COMMITTED/SHIPPED coverage computed before
reserving more). RLS session var + tx registration inside the transaction is correct.

### 4.2 Order lifecycle (good) ✅

`order-lifecycle.ts` — explicit transition table; terminal states (`FULFILLED`,
`CANCELLED`, `FAILED`) have no exits. `order.service.ts` upserts on
`(storeId, externalOrderId)` (idempotent webhook sync), reconciles reservations on
pre-fulfillment line changes, releases active reservations on cancel/line removal,
and routes unknown SKUs to `FAILED` + HIGH exception rather than guessing (with the
`map-shopify-sku.ts` operator remediation path).

**Findings:**

- **B-1 (Medium, documented).** Cancellation after COMMIT/SHIP does not restore stock
  (returns model does not exist yet). Operators can be misled by balances after a late
  cancel; at minimum the exception flow should flag "manual stock correction needed".
- **B-2 (Low).** `canTransitionOrder(from, …)` indexes `allowedTransitions[from]`
  without a guard — an unexpected `from` value throws `TypeError` instead of a domain
  error. Fails closed (no transition happens), so this is cosmetic robustness.
- **B-3 (Low).** `TenantRlsInterceptor`'s `firstValue` resolves only the first
  observable emission. Correct for HTTP responses; subtle if a handler ever streams.

### 4.3 Webhook processing ✅

Atomic claim (`updateMany` RECEIVED→PROCESSING, count-checked), audit events on start/
ignore/failure, compliance/privacy topics handled *before* the store-status check
(merchant data rights survive uninstall — a thoughtful detail), disconnected-store
deliveries are marked processed-with-reason rather than retried forever, unsupported
topics acknowledged cleanly. Business failures (unknown SKU) become exceptions, not
infinite retries; infrastructure failures retry to `DEAD_LETTER`.

---

## 5. AI layer (well-guarded) ✅

- **Tools are read-only by construction** (`ai-tools.service.ts`): the agent can
  investigate, never mutate. Consequential actions only via structured
  `AiDecisionProposal`, executed through the same `AiDecisionService.approve()` path
  humans use (same verification, memory, audit).
- **Bounded autonomy** (`ai-autonomy.service.ts`) — hard rails that policy *cannot*
  override: only `LOW` risk-tier proposals ever auto-execute; policy must exist, be
  enabled and `AUTO_BELOW_THRESHOLD`; confidence threshold gate; `maxActionsPerHour`
  throttle with an `AI_AUTONOMY_THROTTLED` audit event; evaluation failures leave the
  proposal `PROPOSED` for humans (fail-safe). ✅ Verified line by line.
- **Actuation** goes through platform `ActionAdapter`s with a post-action `verify()`
  step; adapter resolution is tenant+store scoped.
- LLM inputs are bounded (`AI_INVESTIGATION_MAX_TOOL_CALLS/TIMEOUT/MAX_TOKENS`).

**Findings:**

- **A-1 (Medium).** Prompt-injection surface: merchant-controlled data (product titles,
  SKUs, order notes) flows into investigation prompts and tool results. The
  read-only-tools + proposal-gating design contains the blast radius (an injected model
  can at worst propose nonsense), and React escapes proposal text in the UI. Residual
  risk: an approved proposal's `note`/parameters reach Shopify write-back. Add explicit
  allowlists on proposal payload fields (e.g. quantity ranges) in the actuation layer
  rather than trusting the structured output shape alone.
- **A-2 (Low).** `GroqLlmClient` has no retry/backoff on transient Groq errors; an
  investigation fails hard. Acceptable for now (fail-safe), but cheap to add.

---

## 6. Tooling, tests, CI

**Strengths:**

- 32 spec files / **201 tests, all passing**; meaningful coverage of the risky paths
  (RLS interception, allocation, webhook intake/processor, HMAC, env validation,
  autonomy, actuation).
- `scripts/sync-test-enums.mjs` + `npm run test-utils:check` generate the mocked Prisma
  enums from the schema and fail on drift — this directly prevents the "silent
  `undefined` enum" failure class the README describes (and that this audit hit
  first-hand: with a half-generated client, 49 tests failed with `ExceptionSeverity`
  undefined).
- Engine-free Prisma (`engineType = "client"`, `engine: "js"`, driver adapter,
  `patch-package` for the `name`-OID gap) is genuinely thoughtful supply-chain work.

**Findings:**

- **T-1 (High). No CI.** There is no `.github/workflows`. Lint, `tsc`, the 201 tests,
  and `test-utils:check` are not enforced anywhere. This is the single cheapest
  risk-reduction available (the ROADMAP agrees: Phase 0).
- **T-2 (High). All tests are Prisma-mocked.** Zero DB-backed integration tests. The
  ROADMAP itself records that a runaway redirect loop in the RLS layer survived until
  an end-to-end run because mocks couldn't see it. RLS policies, serializable retry
  behavior, and migration correctness are exactly what mocks cannot verify.
- **T-3 (Medium, documentation accuracy).** The README claims `prisma generate` works
  "with nothing but npm-registry access (including in air-gapped CI)". **Verified
  false in this sandbox:** with `engineType = "client"`, Prisma 6.19.3's CLI *still*
  attempts to download `libquery_engine.so.node` from `binaries.prisma.sh` during
  `generate`. Workaround verified: `PRISMA_QUERY_ENGINE_LIBRARY=<existing path>`
  (+ `PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1`) makes generate fully offline. Either
  document these env vars for air-gapped CI or add a small wrapper script that sets
  them. (Runtime and `migrate` genuinely need no binary — the claim is true for those.)
- **T-4 (Low).** No coverage instrumentation (`@vitest/coverage-*` not installed), so
  coverage is unknown.

---

## 7. Repo hygiene

- **H-1 (Low). Root-directory sprawl: 35 one-off scripts** (`.js`/`.ts`/`.ps1`) at the
  repo root, including two large Windows-only PowerShell leftovers
  (`replace-inventory-service.ps1` ≈26KB, `next-order-failure-wiring-inspection.ps1`).
  Operator tooling (`map-shopify-sku.ts`, `replay-shopify-webhook.ts`, …) deserves a
  `scripts/` or `ops/` home; the PS1 one-offs look like completed migrations and can
  likely be deleted.
- **H-2 (Low).** `prisma/migrations/20260815185858_inventory_multi_location_v1/`
  contains `migration.generated.sql` next to the real `migration.sql` — a Prisma draft
  artifact that confuses readers (only `migration.sql` is applied).
- **H-3 (Low).** `shopify-test.json` at root is a fixture; belongs in `fixtures/`.
- **H-4 (Low).** 5 lint warnings (unused imports in `groq-llm.client.ts`,
  `risk-detector.service.ts`, `investigation-context.service.spec.ts`) — trivial to fix.
- **H-5 (info).** `dashboard/` has no tests at all (0 specs). Fine for now; the pages
  are thin API consumers.

**Sandbox note (not a repo bug):** this audit environment blocks `binaries.prisma.sh`,
so `npm test`/`npm run build`'s `pre*` hooks failed at `prisma generate` until the
engine-path override (see T-3). With that override: **201/201 tests pass, build
succeeds.** In a normal networked environment the documented `npm ci && npm test`
flow works as written.

---

## 8. Prioritized recommendations

| # | Priority | Finding | Action |
| --- | --- | --- | --- |
| 1 | 🔴 High | T-1 | Add CI: install → `test-utils:check` → lint → `tsc` → `vitest run` → `nest build`, on Node 22 & 24 |
| 2 | 🔴 High | T-2 | Phase 0 DB-backed integration tests (docker-compose Postgres + `migrate deploy` + RLS assertions incl. cross-tenant denial) |
| 3 | 🟡 Med | S-1 | Boot-time check: warn/refuse if runtime DB role is superuser or `BYPASSRLS`; surface RLS status on `/health` |
| 4 | 🟡 Med | S-3 | Reaper for wedged `PROCESSING` webhook events (age-based requeue → `DEAD_LETTER`) |
| 5 | 🟡 Med | S-5 | Plan session-cookie auth + RBAC before SaaS launch (Phase 3); keep API keys as scoped machine credentials |
| 6 | 🟡 Med | T-3 | Fix the "air-gapped generate" claim; ship the env-var wrapper for offline CI |
| 7 | 🟡 Med | B-1 | Late-cancel of committed/shipped lines must raise a "manual stock correction" exception |
| 8 | 🟡 Med | A-1 | Validate/allowlist proposal payload fields at actuation time, not just schema shape |
| 9 | 🟢 Low | S-4, S-6 | `--token-file`/stdin for connect script; CORS origin allowlist |
| 10 | 🟢 Low | H-1…H-4 | Move root scripts to `scripts/`, delete PS1 leftovers, drop `migration.generated.sql`, fix 5 lint warnings |

---

## 9. What is genuinely strong (keep it this way)

1. **Tenancy as a two-layer invariant** (hashed-key guard + fail-closed RLS with
   transaction-reuse interception) — most startups never get this right.
2. **Webhook durability contract**: verify → persist → bounded enqueue → honest 503,
   with per-store secrets and replay tooling — the details that decide whether you
   silently lose orders.
3. **Honest documentation** (`README`, `ROADMAP`, `SHOPIFY-CONNECT`): the repo states
   its own gaps, explains *why* odd-looking code exists (the Prisma patch, the
   `redirectedToTx` marker, the datasource-url warning), and this audit found almost
   no doc/code drift.
4. **AI autonomy with non-overridable safety rails** and a fail-safe default
   (recommend-only, LOW-only auto-exec, throttled, audited, same path as humans).
5. **Craft around the edges**: generated test enums with a drift gate, timing-safe
  comparisons everywhere secrets are checked, atomic claim semantics, serializable
  allocation with optimistic guards.

**Bottom line:** the code that exists is production-minded and, on the evidence of this
audit (201/201 tests, clean type-check and lint, security paths read line by line),
correct on the paths it implements. The risks are concentrated in what is *missing* —
CI, DB-backed tests, human auth, and the operational half of an OMS (returns,
purchasing, write-back) — which `docs/ROADMAP.md` already schedules in the right order.

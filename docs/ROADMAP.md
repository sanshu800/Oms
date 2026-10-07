# OMS → production-ready SaaS: complete build roadmap

This is the canonical plan for turning this repository into a multi-tenant,
multi-channel OMS SaaS: **operations first, AI intelligence layer second**.

It supersedes the earlier short version of this file. Every phase below states
what ships, how we know it is done, and which existing code it touches.

---

## 1. Honest baseline (what exists today)

| Capability | State | Where it lives |
| --- | --- | --- |
| Engine-free Prisma (generate/migrate with npm access only) | ✅ working | `prisma.config.ts`, `prisma/schema.prisma`, `src/prisma/prisma-adapter.ts`, `patches/` |
| Tenant isolation (API keys + Postgres RLS + transaction reuse) | ✅ verified against a real DB | `src/auth/`, `src/prisma/prisma.service.ts`, migration `…enable_row_level_security` |
| Shopify order intake: create / update / cancel, idempotent, reservation reconcile | ✅ verified end-to-end | `src/webhooks/`, `src/oms/order/order.service.ts` |
| Canonical inventory ledger (item, location, balance, reservation, movement) | ✅ core flows | `src/oms/inventory/` |
| Multi-location allocation (single-location preference, split fallback, serializable retry) | ✅ | `src/oms/inventory/allocation.service.ts` |
| Internal fulfilment & shipment services | ⚠️ exists, **no channel write-back**, no operator UI | `src/oms/fulfillment/fulfillment.service.ts` |
| Returns / refunds / exchanges | ❌ no models, no flows | — |
| Purchasing / receiving (inbound stock) | ❌ `RECEIPT` movement type only | — |
| Stock transfers between locations | ❌ enum values only, no service/API | `InventoryMovementType.TRANSFER_*` |
| Cycle counts (guided) | ⚠️ raw `adjustStock` only, no count workflow/approvals | `src/oms/inventory/inventory.service.ts` |
| Channel inventory sync | ⚠️ Shopify only | `…setShopifyInventoryMapping`, `…syncShopifyInventory`, `map-shopify-sku.ts` (catalogue ↔ Shopify mapping, audited) |
| Exceptions: detect, queue, claim, resolve, audit | ✅ partial | `src/oms/exception/`, `src/oms/resolution/`, `src/oms/risk/`, `src/oms/audit/` |
| Order/inventory read APIs + dashboard views | ✅ | `src/oms/order/order.controller.ts`, `src/oms/inventory/inventory.controller.ts`, `dashboard/app/(dashboard)/` |
| Webhook intake: HMAC verify, durable store, bounded enqueue (503 + FAILED row), reconciling subscription registration, signed local replay fixtures | ✅ | `src/webhooks/webhook-intake.service.ts`, `shopify-register-orders-webhook.ts`, `replay-shopify-webhook.ts`, `fixtures/shopify-webhooks/` |
| Store connection lifecycle: connect (OAuth or custom-app token), encrypted token **and webhook secret** at rest, per-store signature verification, token verification, uninstall → DISCONNECTED + token cleared, privacy topics escalated as HIGH exceptions | ✅ verified against a real DB | `docs/SHOPIFY-CONNECT.md`, `connect-shopify-store.ts`, `verify-shopify-store-token.ts`, `src/webhooks/webhook-processor/webhook-processor.service.ts` |
| AI: investigations, tool calls, proposals, autonomy policy (2 levels), memory, outcome feedback, actuation adapters | ⚠️ early but real | `src/ai/**` |
| User accounts, roles, permissions, sessions | ❌ API keys only (machine auth) | `src/auth/auth-tenant.decorator.ts` |
| Billing, plans, quotas, self-serve signup | ❌ | — |
| CI/CD, integration tests against a real DB, observability, backups | ❌ | no `.github/workflows`, docker-compose for Postgres+Redis only |
| Test suite | ⚠️ 32 files / 200 tests, **all Prisma-mocked** (mock enums generated from the schema, guarded by `npm run test-utils:check`) | `*.spec.ts`, `test-utils/prisma-client.mock.ts`, `scripts/sync-test-enums.mjs` |

Two facts to keep in mind while reading this plan:

1. The mocked test suite is why a runaway redirect loop in the RLS
   interception layer survived until an end-to-end run (it OOM-crashed the
   process on the first reservation). **DB-backed tests are a prerequisite,
   not a nice-to-have** — Phase 0 exists for this reason.
2. The models already anticipate multi-channel (`StorePlatform` includes
   AMAZON/WOOCOMMERCE/EBAY, external-reference tables) but nothing is
   implemented behind them. Do not mistake schema vocabulary for capability.

---

## 2. What "production-ready SaaS" means here

A release is production-ready when **a merchant who has never met us** can:

1. sign up, pay, and connect their stores themselves;
2. run daily operations — fulfil, cancel, return, receive, transfer, count —
   without emailing an engineer;
3. trust that stock numbers across channels are correct and every change is
   attributable;
4. survive our bad day: an incident costs them minutes of visibility, not data.

Internally that translates to eight release gates. Every phase below is
measured against them:

| Gate | Test |
| --- | --- |
| Correctness | Ledger invariants hold; replays are idempotent; no drift after a 30-day soak |
| Isolation | Automated suite proves tenant A can never read/write tenant B, even via bugs in app code |
| Durability | Point-in-time recovery rehearsed; restore verified against integrity checks |
| Recoverability | RTO ≤ 1h, RPO ≤ 5min, demonstrated in a drill — not just documented |
| Security | Least-privilege everywhere, secrets rotated, dependency scanning, pen test booked |
| Observability | Every order/stock change traceable end-to-end; SLOs alert before customers notice |
| Supportability | Support can see a tenant's state and replay a failed event without a deploy |
| Commercial | Metering reconciles with invoices; quota enforcement degrades gracefully |

---

## 3. Architecture invariants

These hold across every phase. A change that breaks one needs an explicit
decision recorded in this file, not a silent workaround.

1. **One canonical SKU per item per tenant; channel identifiers are references.**
   `InventoryItem` is tenant-level; `InventoryItemExternalReference` maps it to
   each store. Never let a channel's SKU become the primary key of truth.
2. **Movements are the ledger; balances are a materialized view of it.**
   Every balance change writes an `InventoryMovement` in the same transaction.
3. **Quantities are integers, money is `Decimal`. Never float.**
4. **Every externally-triggered write is idempotent** (unique external id or
   idempotency key) — webhooks *will* be delivered twice.
5. **Every mutation records an `AuditEvent`** with actor type
   (`SYSTEM`/`USER`/`INTEGRATION`/`AI_AGENT`) and correlation id.
6. **Tenant context is never optional in request/job code.** Cross-tenant work
   goes through `prisma.runAsSystem(...)` with a comment explaining why.
7. **Connectors call services; services don't call channel APIs directly.**
   Channel writes go through the `ActionAdapter`-style seam that already
   exists in `src/ai/actuation/`.
8. **External multi-step work is resumable** (outbox/saga + retry), because
   "call API then update our row" fails halfway in production.
9. **AI never gets a private write path.** It calls the same services, under
   the same authorization, limits, auditing, and verification as a human.
10. **Migrations are forward-only, reviewed, and rehearsed** against a
    production-shaped copy before deploy.

---

## 4. Phase map

| Phase | Goal | Exit criteria (abbreviated) | Depends on |
| --- | --- | --- | --- |
| **0. Foundation hardening** | Make the current slice verifiable and testable | CI runs DB-backed migration + integration + isolation tests on every PR; staging env exists | — |
| **1. Complete the operations core** | One channel, fully operational | A pilot merchant runs 30 days of fulfil/cancel/return/receive/transfer/count with zero engineer intervention and zero drift | 0 |
| **2. Multi-channel** | Sell anywhere, one inventory | 2+ channels live simultaneously; no oversell in a 30-day concurrent-promo soak | 1 |
| **3. SaaS platform** | Self-serve, paid, multi-tenant product | New customer signs up → connects a store → pays, unassisted; RBAC and billing enforced | 1 (parallel with 2) |
| **4. Production readiness at scale** | Survive failure and growth | Drills pass (DR, chaos, load 5× peak); SLOs met for a quarter | 2, 3 |
| **5. AI intelligence layer** | Governed intelligence across all operations | Each AI level runs 30 days in production with clean evals before the next ships | 4 |

Sequencing note: Phase 3 can start in parallel with Phase 2 once Phase 1 is
live for a pilot, because the SaaS shell (accounts, billing) does not depend on
channel count. Phase 5 must not start early: AI over unverified operational
data produces confident wrong answers.

---

## Phase 0 — Foundation hardening (~2–3 weeks, do this now)

**Why first:** every later phase adds models, jobs, and money paths. Without
DB-backed tests and CI, each of those lands on faith.

### Workstreams

**0.1 Database-backed integration tests**
- Add a `test:integration` suite that runs against a real PostgreSQL
  (service container in CI, `pgserver` locally) using `prisma migrate deploy`.
- Cover, at minimum: reservation/release/commit/ship ledger invariants;
  duplicate-webhook idempotency; cancellation after partial fulfilment;
  tenant-isolation matrix (every tenant-scoped table, two tenants, app role);
  RLS interception (redirect path, transaction reuse) — this last one is the
  regression guard for the loop that was found with the production-shaped run.
- Keep the existing mocked unit tests for pure logic; stop using mocks where
  the bug class is "the integration between Prisma and our wrappers".

**0.2 CI pipeline**
- `.github/workflows/ci.yml`: install → `prisma generate` → lint → typecheck →
  unit tests → migrate + integration tests → build → dashboard build.
- Trunk-based: PRs must be green; `main` is always deployable.
- Cache `~/.npm`; cache the generated client keyed on the schema hash.

**0.3 Environments**
- `dev` (docker-compose, current), `staging` (production-shaped, anonymized
  data), `prod` (managed Postgres with PITR, managed Redis).
- Hosts under `APP_DOMAIN=reygent.com`: `api.reygent.com` (production API),
  `api-staging.reygent.com` (staging API), the dashboard as `oms.reygent.com`
  in development (single host: the dashboard rewrites `/api/*` and
  `/webhooks/*` to the API) and `oms-staging.reygent.com` / a distinct
  production dashboard host — kept separate from the API host so a frontend
  deploy cannot interrupt webhook intake. Optionally `api-dev.reygent.com`
  behind a stable Cloudflare Tunnel if a dedicated API hostname is preferred
  during development.
  Webhook subscriptions are registered per store with
  `shopify-register-orders-webhook.ts` (reconciling, `--dry-run` first);
  tunnels are refused outside development. The per-store connection
  procedure — both routes, verification, and failure triage — is
  `docs/SHOPIFY-CONNECT.md`; keep it in step with the scripts, and promote it
  into `docs/runbooks/` when that directory lands (0.6).
- Deployment: build artifact → `prisma migrate deploy` → rolling restart.
  Document the rollback path for a migration (expand/contract pattern).

**0.4 Queue and worker verification**
- End-to-end test: webhook POST → `WebhookEvent` row → enqueue → worker →
  processor → order + reservation, including a forced failure and retry.
- Documented DLQ inspection + replay procedure (`src/queue/`), using the
  signed replay tool (`replay-shopify-webhook.ts`) and the fixtures in
  `fixtures/shopify-webhooks/`, which become the connector contract corpus
  in Phase 2. The tool and fixtures exist; what is still missing is the
  written procedure and a test that drives a real queue (Redis) rather than
  the processor directly.
- **Stuck-event sweeper:** an event left in `PROCESSING` because a worker
  died mid-run is not currently re-queued. Add a periodic job that finds
  `PROCESSING` rows older than the processing timeout, marks them FAILED
  with a reason, and re-queues them (or escalates to an exception).
- **Webhook health per store+topic:** last received, last failed, failure
  rate, and an alert when a topic goes quiet past its normal cadence. This
  is what turns "the subscription vanished" into a minutes-level signal
  instead of a month-end discovery.

**0.5 Minimum observability**
- Request/job correlation id propagated into logs and into `AuditEvent`.
- Structured logs with `tenantId`, `storeId`, `orderId` where applicable.
- `/health` (liveness) and `/ready` (DB + Redis reachable) split.
- Metrics endpoint: queue depth, webhook failure count, job duration.

**0.6 Operational runbook skeleton**
- `docs/runbooks/`: replay a webhook, unlock a stuck order, investigate a
  stock discrepancy, rotate a store token, restore from backup.

**Exit criteria:** a red test on `main` is impossible without CI stopping the
merge; a new engineer can run the full suite locally with one command;
staging deploy happens on every merge to `main`.

---

## Phase 1 — Complete the operations core (Shopify-complete)

**Goal:** one Shopify store, multiple locations, run for real. This is the
phase that makes the product sellable; AI stays in the background.

### 1.1 Order lifecycle completion
- Fulfilment states wired end-to-end: `READY_TO_FULFILL → FULFILLING →
  FULFILLED` with partial fulfilment support (`partially_fulfilled`).
- Cancellation policy matrix: before fulfilment (release reservations),
  after partial fulfilment (release remainder, keep shipped), after full
  fulfilment (must go through returns, not cancel).
- Order-level operations: hold/release, notes, tags, manual order creation,
  address/contact correction with audit.
- **Acceptance:** every transition has a test; no transition can strand stock
  (property test: after any legal sequence, Σ balances == Σ movements).

### 1.2 Fulfilment & shipments, including channel write-back
- Operator flow in the dashboard: pick list per location, pack, ship with
  carrier + tracking, partial shipments, split across locations.
- Shopify write-back: fulfilment create with tracking, idempotent, verified by
  re-reading the external state (mirror the verification pattern in
  `src/ai/actuation/shopify-action.adapter.ts`).
- Outbox/saga for "OMS committed stock but Shopify call failed" — must be
  resumable and visible as an exception, never a silent divergence.
- **Acceptance:** kill the worker between commit and write-back; restarting
  converges both sides without duplicates.

### 1.3 Returns, refunds, exchanges
- New models: `ReturnAuthorization`, `ReturnLine`, `Refund`, plus movement
  types for return receipt / restock / write-off (extend
  `InventoryMovementType`).
- Flows: customer-initiated or operator-created; receive → inspect →
  restock/write-off/scrap; refund linked to the original order and payment
  channel; partial returns; exchange = return + new order with reservation.
- Channel sync: restock reflection and refund push per platform capability.
- **Acceptance:** return of a partially shipped order restocks exactly the
  returned quantity at the chosen location, with movement trail, and the
  refund reconciles to the payment amount.

### 1.4 Inbound: purchasing and receiving
- Models: `Supplier`, `PurchaseOrder`, `PurchaseOrderLine`, `Receipt`.
- Flow: raise PO → expected date → receive full/partial/over → `RECEIPT`
  movement → discrepancy exception (short/over/damaged).
- Cost capture (unit cost, landed-cost fields later) so margin reporting is
  possible without re-importing history.
- **Acceptance:** receiving against a PO twice does not double-count;
  over-receipt raises an exception instead of silently accepting.

### 1.5 Transfers and cycle counts
- Transfers: draft → dispatched (`TRANSFER_OUT`) → in-transit → received
  (`TRANSFER_IN`) → discrepancy handling. In-transit stock must be explicit
  (neither available nor lost).
- Cycle counts: scheduled/spot count per location and SKU range, capture
  counted vs system, variance approval thresholds, adjustment with reason
  code, full audit.
- **Acceptance:** a transfer killed mid-flight leaves stock counted exactly
  once, and a count cannot adjust stock without an approver when the variance
  exceeds the tenant threshold.

### 1.6 Inventory integrity & reconciliation
- **Ledger invariant job:** recompute balances from movements; alert and flag
  (never auto-heal silently) on mismatch.
- **Reservation leak detector:** ACTIVE reservations older than N days or
  attached to terminal orders.
- **Channel drift job:** compare OMS available vs each channel's reported
  available per SKU/location; classify (ours wrong / theirs wrong / expected
  in-flight) and open exceptions.
- Reconciliation report per day per store — the artifact a merchant trusts.

### 1.7 Order intake robustness
- Scheduled reconciliation pull per store (catch webhooks we never received),
  with overlap window and idempotent upsert.
- Backfill tool: import orders from a date range with progress + resumability.
- Replay tooling for `WebhookEvent` rows in FAILED/DEAD_LETTER, extending
  `replay-shopify-webhook.ts` into an operator action (and later a UI action).
- Webhook registration/health UI: which topics are registered, last received,
  last failed — surfaced from the same data the registration script
  reconciles against.

### 1.8 Operator surface (dashboard)
- Exceptions queue with SLA clock, assignment, bulk actions.
- Order list: saved views, search by order number/customer/SKU, bulk fulfil,
  export CSV.
- Inventory: per-location stock, incoming (PO), in-transit (transfers),
  reserved, available; adjustment and transfer wizards.
- Audit trail viewer per order/SKU/location.

### 1.9 Internal users and roles (before Phase 3's full RBAC)
- Minimal `User` + membership model so real staff can log in with roles
  (owner/manager/agent/viewer) instead of sharing a tenant API key.
- API keys become machine credentials only, scoped and rotatable.

**Phase 1 exit criteria**
- A pilot merchant runs 30 consecutive days: fulfil, cancel, return, receive,
  transfer, count — with **zero engineer interventions** and **zero
  unexplained stock movement**.
- Reconciliation jobs report no drift against Shopify for 30 days.
- Every mutation in that window is attributable in `AuditEvent`.
- Practice: hit each runbook once (replay, stuck order, discrepancy).

---

## Phase 2 — Multi-channel

**Goal:** the merchant sells on Shopify + Amazon (+ WooCommerce/eBay) with one
inventory truth and no oversell.

### 2.1 Connector contract (extract from the Shopify path)
Define in `src/channels/` (new), mirroring the existing adapter seam:

```ts
interface ChannelConnector {
  readonly platform: StorePlatform;
  verifyCredentials(store): Promise<StoreHealth>;
  ingest: { fetchOrdersSince, fetchOrder, registerWebhooks, parseWebhook };
  inventory: { pushAvailable, fetchAvailable, supportsMultiLocation };
  fulfilment: { pushFulfilment, pushTracking, cancelFulfilment };
  returns: { pushRefund, restockPolicy };
  rateLimit: RateLimitBudget;      // shared, per store
  capabilities: ChannelCapabilities; // feature flags, not assumptions
}
```

- Store-scoped credentials, refresh, and health on `StoreConnection`.
- Channel-capability flags so the OMS never assumes a platform supports
  multi-location or partial fulfilment.
- Ingestion is generic: verify → persist raw event → enqueue → normalize →
  service call. Platform parsing is a pure function with fixture tests.

### 2.2 Move Shopify behind the contract
- No behaviour change; contract tests run the existing scenarios through the
  new seam to prove parity before Amazon work starts.

### 2.3 Mapping and catalog
- SKU/listing mapping UI with bulk import, unmatched-SKU exception workflow,
  and "map on the fly" during exception resolution.
- Bundles/kits deferred to a later phase but designed for (composition table).

### 2.4 Amazon (SP-API)
- Orders (LWA client credentials, per-tenant credential storage), feeds for
  inventory and fulfilment, FBA vs FBM handling, throttling with token-bucket
  budget shared across processes, credential rotation.
- Amazon-specific behaviours that must not leak into the core: order
  acknowledgement deadlines, cancellation windows, feed result polling.

### 2.5 WooCommerce (REST + webhooks) and eBay (Sell API + polling)
- Cheaper, faster connectors to validate the contract's generality: one
  webhook-based, one poll-based.

### 2.6 Cross-channel allocation policy engine
- Safety stock per SKU/location; per-channel buffer (never publish 100% of
  available); allocation priority; hard oversell prevention via reservation
  serialization across channels.
- Channel feed coordination: converge to target with backoff, don't flap on
  every movement; batch + debounce.
- **Acceptance:** with two channels and one SKU, concurrent high-volume sale
  on both never oversells; each channel's published number converges within
  the configured freshness window.

### 2.7 Channel operations console
- Per-channel health: auth status, last successful poll/feed, error rate,
  drift, publish lag, current throttle state.
- Per-channel inventory publish log (what did we tell them, when, result).

**Phase 2 exit criteria**
- Two or more channels live for the pilot merchant for 30 days including a
  promotion; zero oversells; per-channel drift below 0.1% at daily close;
  every connector failure observed by an alert and resolved from a runbook.

---

## Phase 3 — SaaS platform (parallel with Phase 2 after Phase 1)

**Goal:** customers onboard and pay without us.

### 3.1 Identity and access
- `User`, `Membership`, sessions (JWT access + refresh), password reset,
  email verification, optional MFA, SSO-ready (SAML/OIDC later for enterprise).
- Invitations and seat management.

### 3.2 RBAC and authorization
- Permission matrix by role and scope (tenant-wide vs store-scoped), enforced
  centrally in a guard, tested per endpoint. Machine keys get explicit scopes.
- Every AI action inherits the *requesting user's* permissions, never a
  superuser.

### 3.3 Tenant provisioning and onboarding
- Self-serve signup → tenant + owner + trial; org settings, timezone,
  currency, tax basics.
- Store connection wizard generalizing the existing Shopify OAuth flow
  (`src/shopify/shopify-auth.controller.ts`).
- Onboarding checklist with progress; import wizard (locations, SKUs,
  opening balances, mapping).

### 3.4 Billing, plans, quotas
- Plans by orders/month + stores + locations; metering from an append-only
  usage table; Stripe subscriptions, trials, proration, dunning, invoices.
- Quota enforcement that degrades gracefully: over-quota blocks *new* volume
  with clear messaging; never drops in-flight orders or corrupts inventory.
- Usage dashboard: current period, forecast, plan comparison.

### 3.5 Back-office admin console
- Tenant search/lookup, health snapshot, usage, plan, audit-of-support-actions,
  impersonation (time-boxed, audited, consented), feature flags, manual
  credit/refund, replay a tenant's failed events.

### 3.6 Tenant lifecycle and data governance
- Suspend/reactivate (read-only mode), export everything (JSON + CSV),
  delete with retention rules, per-tenant encryption of store tokens (KMS),
  key rotation without downtime.
- Subject-access and erasure requests satisfied end-to-end.

### 3.7 Compliance and trust
- Sub-processor list, DPA, data-residency options, retention policy,
  security page, SOC 2 readiness checklist, external pen test, vulnerability
  disclosure, posture for GDPR/CCPA.

### 3.8 Support and docs
- Public API + webhook reference (generated from the code), status page,
  in-app help, changelog, error surfaces that include the correlation id the
  support team can search.

**Phase 3 exit criteria**
- A stranger signs up, connects a store, and pays, with no manual step.
- RBAC verified by an endpoint-by-endpoint matrix test; two tenants sharing a
  user is impossible by construction.
- Billing metering reconciles to the invoice for a full cycle (±0.5%).
- Export + delete verified on a seeded tenant, including RLS-protected tables.

---

## Phase 4 — Production readiness at scale

**Goal:** survive growth, failure, and attackers.

### 4.1 Delivery
- Infrastructure as code; ephemeral preview environments per PR (DB + Redis +
  seeded anonymized data); staging mirrors prod topology; deploy = migrate
  (expand) → rolling restart → contract migration; documented rollback and
  feature flags for risky changes.

### 4.2 Data platform
- Backups with PITR, restore rehearsed quarterly *with integrity verification*
  (ledger invariants + count parity after restore).
- Partitioning/archival plan for high-volume tables (`InventoryMovement`,
  `WebhookEvent`, `AuditEvent`, `AiToolCall`); read replica for reporting if
  analytics queries threaten the write path.

### 4.3 Observability and SLOs
- OpenTelemetry traces across HTTP → queue → DB → channel call.
- Domain metrics that matter: intake lag, webhook failure rate, queue lag,
  allocation conflicts, reservation leaks, channel drift, publish lag,
  oversell counter (must stay 0), AI action verification failures.
- SLOs with error budgets: intake availability 99.9%, API p95 latency,
  fulfilment write-back success, reconciliation freshness.
- Alert routing: page for customer-impacting, ticket for internal; every alert
  links to a runbook.

### 4.4 Performance and cost
- Load tests at 5× projected peak, including webhook storms and channel feed
  backlogs; admission control and backpressure so overload degrades to
  queuing, never to corruption.
- Connection pooling (PgBouncer), query budgets, N+1 elimination on list
  endpoints, caching for read-heavy views.
- Cost model per order/tenant; alert on unit-cost regression.

### 4.5 Security engineering
- Threat model per surface (webhook forgery, token theft, SSRF to channel
  APIs, tenant breakout via crafted ids, prompt injection reaching tools).
- Secrets in a manager, not env files in prod; rotation runbook exercised.
- Per-tenant and per-key rate limits; dependency + container scanning in CI;
  least-privilege DB roles per environment; audit immutability (append-only,
  no delete for support).
- Incident response plan with severity matrix, comms templates, and drills.

### 4.6 Reliability engineering
- Outbox/saga everywhere an external call accompanies a DB write; poison
  message quarantine with replay; chaos drills (kill worker mid-fulfilment,
  DB failover, Redis loss) with measured recovery.
- On-call rotation, blameless postmortems, action-item tracking.

**Phase 4 exit criteria**
- DR drill: RTO ≤ 1h, RPO ≤ 5min, integrity verified.
- Load: 5× peak sustained; no data loss, no oversell, bounded latency.
- Chaos drills passed; every page-worthy alert has a runbook and was
  triggered at least once in a game day.
- Security: pen test findings remediated or accepted with owners.

---

## Phase 5 — AI intelligence layer (advance, only after operations are trusted)

**Goal:** AI that investigates, explains, proposes, and — within hard bounds —
acts across purchasing, inventory, fulfilment, returns, and channel publishing.

**Rule of the phase:** capability level N+1 ships only after level N has run
30 days in production with clean evals. AI is a consumer of the operational
core, never a shortcut around it.

### 5.0 Foundations (data, evals, cost)
- Historical event/feature store from the operational tables (order events,
  movements, reservations, channel feeds, exceptions, outcomes) so the AI can
  be evaluated offline against real history.
- **Evaluation harness with a golden set** built from past incidents: known
  root causes, known correct actions; every prompt/model change runs it.
- Per-tenant cost/latency budgets; tool-call caps; strict data scoping so a
  tenant's context can never include another tenant's rows (tested).

### 5.1 Level 0 — Insights (read-only)
- Daily operational digest: what changed, what's at risk, what needs a human.
- Anomaly detection: stock/velocity anomalies, fulfilment ageing, exception
  spikes, channel publish lag, refund clustering.
- Natural-language Q&A over the tenant's own data with **citations to rows**;
  refuses to answer beyond its scope rather than guessing.
- Uses and extends `src/ai/investigation/` + `src/ai/memory/`.

### 5.2 Level 1 — Diagnosis
- Root cause over the operational graph: order → reservation → movement →
  channel feed → external event; cross-channel and cross-location reasoning
  (oversell risk, split-channel stockouts, misrouted transfers).
- Confidence + uncertainty stated explicitly; "I don't know" is a valid and
  preferred output over a plausible wrong cause.
- Every investigation stored (`AiInvestigation`, `AiToolCall`) and reviewable.

### 5.3 Level 2 — Proposals with simulation
- Every proposal carries: the diff, expected effect, risk tier, reversibility,
  and the evidence it used (extend `AiDecisionProposal` +
  `AiRiskTier`/`AiDecisionBasis`).
- **Shadow simulation** against a copy of the ledger: "what would have happened
  if we applied this last month?" — presented with the proposal.
- Approval UI side-by-side with predicted vs actual after execution.

### 5.4 Level 3 — Bounded autonomy
- Expand `AiAutonomyLevel` beyond RECOMMEND_ONLY into per-action-type policies
  with hard limits: max units, max value, allowed SKUs/locations/channels,
  time windows, daily caps, and mandatory cooldowns.
- Rollout per tenant: shadow mode (propose only) → co-signed → autonomous
  within limits → expanded limits. Global and per-tenant kill switch.
- Execution strictly through the same service methods humans use, with
  `AuditEvent(actor = AI_AGENT)`, followed by verification read-back and
  automatic rollback + escalation on mismatch. (The verification pattern is
  already prototyped in `src/ai/actuation/`.)
- Escalation rules: anything outside limits, ambiguous evidence, or a failed
  verification goes to the human queue with the reasoning attached.

### 5.5 Level 4 — Optimization
- Replenishment suggestions and PO drafting from velocity, lead times, and
  in-transit stock; transfer optimization balancing stock-out risk vs shipping
  cost; safety-stock tuning per channel.
- Fulfilment routing: split-shipment decisions weighing cost, speed, and SLA.
- Returns prevention signals; refund/return anomaly detection (abuse, process).
- Channel coordination: what to publish when buffers are tight.

### 5.6 Governance, safety, and trust
- Model/prompt/policy versioning with eval gates in CI; regression blocks a
  rollout the same way a failing test does.
- AI audit ledger: every tool call, action, outcome, and the policy version in
  force — sufficient to reconstruct any AI decision months later.
- Prompt-injection defense: untrusted content (customer notes, product text,
  channel payloads) never reaches tool selection; tools are allow-listed by
  action type, and destructive actions require policy approval.
- Tenant controls: opt-in per capability, data-handling terms (no training on
  tenant data), explanation quality review, human-override feedback that
  actually adjusts future behavior (`AiOutcomeFeedback` loop closed).
- Incident playbook for a bad AI action: kill switch, rollback, affected-tenant
  notification, eval case added from the incident.

**Phase 5 exit criteria**
- Level 0–2 adopted by pilot tenants with measured time saved on exception
  triage (target: ≥30% reduction in human minutes per exception).
- Level 3 autonomy: zero unverified actions, zero limit breaches, every
  rollback triggered correctly in drills, and a documented decision to expand.
- Level 4 features each carry an eval gate and a measured operational outcome
  (stockouts avoided, transfer cost saved, late shipments reduced).

---

## 5. Cross-cutting quality bars

**Definition of done for any feature**
1. Migration reviewed and rehearsed; expand/contract if destructive.
2. Unit tests for logic + integration test for the DB interaction + a test that
   replays the failure mode it guards against.
3. Idempotency considered and tested for anything triggered externally.
4. Audit event written; correlation id propagated.
5. Runs under tenant RLS with a negative test (wrong tenant gets nothing).
6. Runbook entry if it can fail in production; dashboard/alert if it can fail
   silently.
7. Docs updated (README/roadmap/API reference).

**Testing pyramid for this system**
- Pure logic (pricing, allocation math, parsers) → fast unit tests.
- Service + real Postgres (ledger, RLS, idempotency, transactions) → integration.
- Contract tests per channel connector, driven by recorded payload fixtures.
- End-to-end: webhook/poll → order → fulfilment → channel write-back → verify.
- Load + chaos: scheduled, not ad hoc (Phase 4).
- Never mock the database in a test whose purpose is database behaviour.

**Anti-goals for now (deliberately deferred)**
- Microservices split — a modular monolith with clean seams serves this scale.
- Custom warehouse/ERP, WMS hardware, shipping-rate shopping, tax engines.
- Marketplace/multi-merchant (tenant = merchant stays true).
- LLM fine-tuning before the eval harness and Level 3 governance exist.
- Multi-region active/active before single-region reliability is boring.
- Building our own queue, auth, or payment stack.

**Top risks**
| Risk | Mitigation |
| --- | --- |
| Unverified data drives confident AI decisions | Phase gating; AI reads only verified operational data; citations required |
| Oversell during a promotion across channels | Reservation serialization + buffers + soak tests before launch |
| Channel API changes/deprecations | Capability flags + contract tests + per-channel health alerts |
| Tenant data leakage | RLS + isolation test suite in CI on every PR |
| Silent stock drift | Ledger invariant job + drift reconciliation + daily report |
| Cost blow-up (LLM or infra) | Per-tenant budgets, cost per order metric, alerting |
| Solo-founder bandwidth | Sequence phases; pilot merchant before building Phase 2 breadth |
| Migration incident in production | Expand/contract + rehearsed restore + feature flags |

---

## 6. Sequencing, team shape, and rough milestones

Estimates assume a small team; a solo builder should read them as calendar
durations and cut scope, not quality.

| Phase | Solo | 2–3 engineers | First credible milestone |
| --- | --- | --- | --- |
| 0 | 2–3 wks | 1 wk | CI with DB-backed tests green |
| 1 | 3–5 months | 2–3 months | Pilot merchant live for 30 days |
| 2 | 3–4 months | 1.5–2 months | Second channel live, no oversell |
| 3 | 2–3 months (parallel) | 1–1.5 months | Self-serve paid signup |
| 4 | 2–3 months | 1–1.5 months | DR + load drills passed |
| 5 | ongoing, staged | ongoing | Level 3 autonomy with limits |

Commercial sequencing that matches this: pilot (free/design partner) during
Phase 1 → design partners during Phase 2 → public self-serve at end of Phase 3
→ enterprise readiness after Phase 4.

---

## 7. Next 10 working days (concrete)

1. `.github/workflows/ci.yml` with lint, typecheck, unit, build, dashboard build.
2. Postgres service container + `test:integration` script bootstrapping
   `migrate deploy` against a scratch database.
3. Integration tests: ledger invariants, duplicate webhook, cancellation after
   partial fulfilment, tenant-isolation matrix, RLS redirect regression.
4. `/ready` endpoint (DB + Redis) and correlation-id logging.
5. Queue end-to-end test with a forced failure, retry, and DLQ replay
   (the signed-replay harness and fixtures already exist); write the replay
   runbook, plus the stuck-`PROCESSING` sweeper.
6. `docs/runbooks/` skeleton with the five runbooks listed in Phase 0.
7. Staging environment definition (managed Postgres + Redis) and a documented
   migrate-then-deploy procedure.
8. Phase 1 backlog groomed into tickets with acceptance criteria, starting with
   fulfilment write-back (1.2) since it is the largest gap between "we store
   orders" and "we run a warehouse".

# Shipping-Provider Integration (Shiprocket) — Implementation Plan

**Status:** Planning + contract complete (Stage 7). No real provider adapter implemented yet — per scope, the FAKE WMS adapter stays and deterministic testing uses fakes.
**Contract:** [`src/shipping/shipping-contract.ts`](../src/shipping/shipping-contract.ts) v1.0 · mapping: [`src/shipping/shipping-status-mapping.ts`](../src/shipping/shipping-status-mapping.ts) · tests: `src/shipping/*.spec.ts` (20 tests).

## 1. State ownership (authoritative)

| Layer | Owner | Facts |
|---|---|---|
| Warehouse | WMS (contract `src/wms/wms-contract.ts`) | ack, picking, packing, **warehouse handover** |
| Carrier | Shipping provider (this contract) | shipment creation, AWB, label, **courier handover**, tracking, delivery, cancellation outcomes |
| Projection | TechMart OMS | canonical `Fulfillment` / `Shipment` / `Order` rows; only the OMS writes them |

Hard rules (contract-pinned tests):

- **Packing or AWB/label generation alone must never mark an order shipped.** `AWB_ASSIGNED`, `PICKUP_SCHEDULED`, `PENDING` map to `record_progress` / `record_label_created` only. Only courier handover proof (`IN_TRANSIT` and later carrier movement) maps to `record_handover_confirmed` → `shipShipment()` (Shipment `IN_TRANSIT`, Order `SHIPPED`).
- **Cancellation request ≠ cancellation confirmed.** `cancellation_requested` is a soft state recorded as `cancellationRequestedAt` bookkeeping; only provider-confirmed `cancelled` calls `cancelShipment()` (Shipment `CANCELLED`, order released). Wire events `shipping.cancellation.requested` / `.confirmed` are distinct.

## 2. Proposed canonical actions (reducer output)

`mapShippingEventToCanonicalAction` is the only sanctioned reducer: `record_shipment_created`, `record_label_created` (→ `labelShipment()`, stops at `LABEL_CREATED`), `record_handover_confirmed` (→ `shipShipment()`), `record_delivered` (→ `deliverShipment()`), `record_cancellation_requested` (bookkeeping only), `record_cancellation_confirmed` (→ `cancelShipment()`), `record_progress` (no domain mutation), `reject_event` (reason + audit, no mutation — mirrors WMS convention).

## 2a. Cancellation semantics (Stage 2.1, tested)

A confirmed cancellation always applies to **one shipment** (`cancelShipment`) — sibling shipments and their items/history are never touched. What happens next depends on the fulfillment's state:

| State of the fulfillment | Fulfillment cancelled? | Inventory released? | Reconciliation |
|---|---|---|---|
| **Partially shipped** (a sibling is `IN_TRANSIT`/`DELIVERED`, or status `PARTIALLY_FULFILLED`/`FULFILLED`) | **No** | **No — never** | Flagged |
| **Sibling shipments live, nothing shipped** | No | **No** (would free the siblings' reservations) | Audit only (`SHIPPING_SHIPMENT_CANCELLED`) |
| **Cancelled shipment is the last live one, nothing shipped** | Yes (`READY`/`IN_PROGRESS`) | Yes — `releaseOrder` is **correct** here | — |

Why the partial case never releases: `InventoryReservation` rows are **per order item** (they cover shipped and unshipped units alike), and `InventoryService.releaseOrder` frees whole `ACTIVE` reservations. Releasing after a partial shipment would return already-shipped units to stock — an over-release. The remainder reservation therefore stays `ACTIVE` pending operator reconciliation (`needsReconciliation` + reason on the cancelled shipment); a partial-release capability in `InventoryService` would be a separate, deliberate domain change.

A cancellation REQUEST (`cancellationRequestedAt`) is soft bookkeeping and never changes any status. If handover/delivery wins the race (committed first), the verified provider state is preserved and reconciliation is flagged; if cancellation wins, later handover/delivery events are quarantined (with the same flag).

## 2b. Inventory transaction ordering (Stage 2.1)

Reservations move `ACTIVE → COMMITTED` (`commitOrder`, via `FulfillmentService.complete()` when every unit is allocated to live shipments) and `COMMITTED → SHIPPED` (`shipOrder`, via `shipShipment()`). Integrations must therefore **`complete()` before `shipShipment()`** — the same sequence the canonical order flow uses (`FULFILLING → FULFILLED` transitions). The reverse order makes `shipOrder` a silent no-op (it only moves `COMMITTED` rows) and strands reservations at `COMMITTED`. Both the WMS and shipping processors do this in that order; the real-DB scripts assert the `SHIPPED` reservation state.

## 3. Shiprocket API research (public docs, Oct 2026)

Sources: [apidocs.shiprocket.in](https://apidocs.shiprocket.in/), [apidocs-test.shiprocket.in](https://apidocs-test.shiprocket.in/), [Shiprocket support help sheet](https://support.shiprocket.in/support/solutions/articles/43000337456-shiprocket-api-document-helpsheet).

- **Base URL:** `https://apiv2.shiprocket.in/v1/external/` (JSON over HTTPS).
- **Auth:** create a dedicated **API user** in the panel (Settings → API → Configure → Create API User — *not* the panel login). `POST /auth/login` with that email+password returns a JWT; send `Authorization: Bearer <token>`; token lifetime documented as **240 hours (10 days)** (some third-party docs say 24h — treat as short-lived and refresh proactively). No separate OAuth app or signed requests.
- **Typical flow:** `POST /orders/create/adhoc` (order_id, pickup_location, buyer address, order_items, dimensions) → returns Shiprocket `order_id` + `shipment_id` → `POST /courier/assign/awb` (courier selection → `awb_code`) → `POST /courier/generate/pickup` → `POST /courier/generate/label` (PDF URL) → manifest APIs → `GET /courier/track/awb/{awb_code}`. Cancellation via order-cancel APIs **before dispatch** only.
- **Webhooks:** Settings → API > Webhooks: callback URL + optional security token; tracking events pushed as `POST application/json`. Shiprocket is explicit that the security token is *optional* — our contract makes `verifyInbound` **mandatory** regardless.
- **Implication for state ownership:** in Shiprocket's flow, AWB assignment and label generation happen *before* the courier ever sees the parcel. Their "pickup scheduled/pickup generated" is a request, not proof of handover. Only the first carrier scan ("in transit"/"picked up") proves handover — exactly matching the contract rule above.

### Credentials checklist (never commit; per-connection, encrypted)

1. Shiprocket account (panel) with pickup address(es) configured.
2. API user email + password (Settings → API → Configure) → stored encrypted like WMS secrets (`encryptSecret`, no env fallback).
3. Webhook security token (Settings → API > Webhooks) → stored encrypted; required by our `verifyInbound`.
4. **No production API access is assumed**; a test/sandbox account is NOT confirmed available (open question §7). All development runs against the FAKE shipping provider.

## 4. Schema changes needed (Stage 2 — NOT applied yet)

- `ShippingConnection` model (mirror `WmsConnection`): `tenantId`, `provider` (SHIPROCKET), `apiEmail`, `apiPasswordEnc`, `webhookSecretEnc`, `baseUrl?`, status; unique `[tenantId, provider]`.
- `ShippingEvent` model (mirror `WmsEvent`): intake/dedup on `(connectionId, externalEventId)`, claim pattern `RECEIVED→PROCESSING`, RLS like `20260822161416` + `20261009120000`.
- `Shipment` extensions (additive): `awbCode?`, `labelUrl?`, `courierName?`, `externalOrderId?` (provider order id), `handedOverAt?`, `deliveredAt?`, `cancellationRequestedAt?`, `cancellationRequestRef?`, `lastProviderStatus?`.
- **Decision:** `ShipmentStatus` keeps exactly one terminal `CANCELLED` (confirmed only). The request state lives in `cancellationRequestedAt` bookkeeping — this preserves the request/confirmation distinction without adding an ambiguous status.

## 5. Staged implementation

- **Stage 2 — Shipping foundation (next).** Migration above; `ShippingConnection` CRUD (tenant-key guard + RLS + encrypted secrets, mirror `wms.controller.ts`); `shipping-event` queue job in the existing single webhook worker (dual dispatch like `wms-event`); `ShippingEventIntakeService` + `ShippingEventProcessorService` calling the reducer then `FulfillmentService` methods (`labelShipment` / `shipShipment` / `deliverShipment` / `cancelShipment` + new `requestCancellation` bookkeeping); `FakeShippingProviderAdapter` for deterministic tests; real-db script mirroring `wms-foundation-real-db-test.ts`.
- **Stage 3 — Shiprocket adapter.** `ShiprocketShippingAdapter` implementing `ShippingProviderAdapter` (token cache + refresh, create/assign-awb/label/cancel/track calls with `requestId` idempotency), webhook endpoint with `verifyInbound` (security token), reconciliation poller for open shipments (runs through the same reducer). Feature-flagged; secrets per connection.
- **Stage 4 — Handover unification & hardening.** Reconcile WMS `fulfillment.shipped` (warehouse handover) with carrier first-scan (`record_handover_confirmed`) — either may fire first; canonical `IN_TRANSIT`/`SHIPPED` set by whichever proves courier possession, the other is a no-op. Load/idempotency tests, runbook.

## 6. Contract guarantees already enforced in tests

`src/shipping/shipping-status-mapping.spec.ts` + `shipping-contract.spec.ts` (20 tests): version guard; AWB/label/pickup never handover; cancellation request vs confirmation distinct at status, wire-event, and action levels; unknown input rejects with stable reasons; adapter registry shape.

## 7. Open questions (need owner decision)

1. **Test account:** does TechMart have a Shiprocket test/sandbox account (apidocs-test), or is Stage 3 developed against the live API with tiny volumes only?
2. **Cancellation SLA:** Shiprocket only cancels *before dispatch*; what should happen to `cancellation_requested` if the carrier scans the parcel first (request auto-fails vs manual resolution flow)?
3. **RTO handling:** treat `RTO_*` as its own order outcome (`RETURNED`?) or reuse `DELIVERY_FAILED` + exception workflows?
4. **Who initiates cancellation** in v1: OMS UI/API first, or provider-panel-initiated only?
5. **Multi-shipment orders:** Shiprocket creates one provider order per fulfillment; if we ever split one fulfillment across couriers, `Shipment.externalShipmentId` stays unique per provider shipment — confirm no business need for courier fallback after AWB assignment (re-assign flow exists in Shiprocket).
6. **Partial-release inventory capability:** after a remainder cancellation on a partially shipped fulfillment, the remainder reservation stays `ACTIVE` (see §2a). A partial-release API in `InventoryService` (release only the unshipped units) would close the loop — needs an owner decision.

## 8. Running the real-database acceptance tests

The real-DB scripts (`wms-foundation-real-db-test.ts`, `shipping-foundation-real-db-test.ts`) verify migrations, RLS tenant isolation, duplicate-event constraints, foreign-tenant invisibility, and inventory transaction behavior against real PostgreSQL.

**Topology matters:** Postgres exempts superusers from RLS unconditionally. Run migrations as the table-owning role, then run the scripts as that same **non-superuser** role (or any restricted role):

```bash
# 1. Start PostgreSQL 17 (or 16) and create a NON-superuser app role:
docker compose up -d db                       # or any local PostgreSQL
psql "$ADMIN_URL" -c "CREATE ROLE oms LOGIN PASSWORD 'oms' CREATEDB;"
psql "$ADMIN_URL" -c "CREATE DATABASE oms OWNER oms;"

# 2. Apply all migrations as the table-owning role:
export DATABASE_URL="postgresql://oms:oms@127.0.0.1:5432/oms"
npx prisma migrate deploy                     # or apply each prisma/migrations/*/migration.sql in order

# 3. Run the acceptance scripts (same DATABASE_URL, non-superuser):
export REDIS_URL="redis://localhost:6379" JWT_SECRET="<32+ chars>" \
       ENCRYPTION_KEY="<32+ chars>" APP_URL="http://localhost:4000"
npx ts-node wms-foundation-real-db-test.ts
npx ts-node shipping-foundation-real-db-test.ts
```

Both scripts print a JSON block with `"result": "PASS"` and per-assertion evidence (reservation states, movement types, RLS checks). Anything else is a failure — never report the gate as passed on a non-PASS run.

## 9. Smallest safe next implementation step

Stage 2's first commit: `ShippingConnection` + `ShippingEvent` migration and models (purely additive) plus the `shipping-event` queue dispatch in the existing webhook worker — no behavior change to any current flow. Then intake/processor with the FAKE shipping adapter behind the same deterministic-test pattern as WMS Stage 1.

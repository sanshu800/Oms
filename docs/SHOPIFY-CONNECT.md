# Connecting a Shopify store to the OMS

This is the operator walkthrough for pointing a real Shopify store at a
deployed OMS. It covers both connection routes, webhook registration, and how
to prove the connection works — plus what to do when a delivery fails.

Work through it in order. Steps 0 and 2 are identical for both routes; only
step 1 (how the access token gets into the database) differs.

---

## Hosts and origins (read this first)

Four different URLs get called "the app URL". They are not interchangeable:

| Value | What it is | Where it is set |
| --- | --- | --- |
| `APP_DOMAIN` | The registrable domain you own, e.g. **`reygent.com`**. Policy, not routing: it lets the app reject an `APP_URL` that is `http`, a tunnel, local, or someone else's domain, and lets the registration script recognise *this* app's subscriptions on a store. | env |
| `APP_URL` | The public origin of the **API** — the thing Shopify posts to, at `<APP_URL>/webhooks/shopify`. Per environment, never a tunnel in production. | env |
| Dashboard host | Whatever hostname your reverse proxy/tunnel points at port 3000. The dashboard has **no URL variable**; it is host-agnostic and its rewrites keep browser calls same-origin (`/api/*`). Development: **`oms.reygent.com`**. | DNS / tunnel / proxy |
| `API_SERVER_URL` | Where the dashboard's server-side rewrites send traffic — the API's *internal* address (`http://localhost:4000`, or the API host in a deployed environment). Never used by the browser. | `dashboard/.env` |

So "the app URL" means the API origin to Shopify, and `oms.reygent.com` is the
hostname you browse. Both can be the same hostname in development:

```
browser ──► oms.reygent.com ──► next (port 3000)
                                  ├── /                    dashboard UI
                                  ├── /?shop=…             → API :4000  (rewrite, OAuth install entry)
                                  ├── /auth/shopify/*      → API :4000  (rewrite, OAuth callback)
                                  ├── /api/*               → API :4000  (rewrite)
                                  └── /webhooks/shopify    → API :4000  (rewrite)

APP_URL=https://oms.reygent.com     APP_DOMAIN=reygent.com
API_SERVER_URL=http://127.0.0.1:4000
```

The webhook rewrite is byte-for-byte, which is what keeps HMAC verification
valid end to end (checked against the real intake: a correctly signed delivery
passes, a forged one is still rejected with 401).

| Environment | Dashboard host (`APP_URL` if single-host) | API origin (`APP_URL`) |
| --- | --- | --- |
| Local, no public host | `http://localhost:3000` | `http://localhost:4000` — webhooks replayed locally |
| Development on your domain | `oms.reygent.com` | `https://oms.reygent.com` (single host) *or* `https://api-dev.reygent.com` (separate API host) |
| Staging | `oms-staging.reygent.com` | `https://api-staging.reygent.com` |
| Production | e.g. `app.reygent.com` | `https://api.reygent.com` |

In production, keep the API on its own host and point `APP_URL` at it: webhook
traffic should not depend on the frontend process being up. In development the
single-host setup is the point — one tunnel, one hostname, no duplicated DNS.

### Development setup behind a tunnel

Point `oms.reygent.com` at the dashboard and leave the API internal:

```sh
# terminal 1 — API (webhooks and API server)
npm run start:dev                     # http://localhost:4000

# terminal 2 — dashboard (UI + /api/* + /webhooks/shopify)
cd dashboard && API_SERVER_URL=http://127.0.0.1:4000 npm run dev

# terminal 3 — one tunnel hostname for the whole project
cloudflared tunnel run --url http://localhost:3000 reygent-dev
# and a DNS route so the hostname is stable:
#   cloudflared tunnel route dns reygent-dev oms.reygent.com
```

Then, on the machine/process that runs the operator scripts (which talk to
Shopify directly):

```sh
APP_URL=https://oms.reygent.com
APP_DOMAIN=reygent.com
```

```sh
npx ts-node connect-shopify-store.ts --shop=<shop>.myshopify.com \
  --token=shpat_… --webhook-secret=<API secret key>

npx ts-node shopify-register-orders-webhook.ts --shop=<shop>.myshopify.com --dry-run
# the URI it registers is https://oms.reygent.com/webhooks/shopify → dashboard → API
```

Two things to keep straight:

- `oms.reygent.com` must reach the **dashboard** (port 3000), not the API, for
  the rewrites to do their job. If you'd rather expose the API directly, that's
  fine too — then `APP_URL=https://api-dev.reygent.com` and give the tunnel a
  second hostname pointing at port 4000.
- Because `APP_URL` is embedded in subscriptions stored on Shopify's side,
  changing it later is safe (the registration script reconciles), but **never
  point a development host at a store production also uses** — that silently
  moves the live store's deliveries to your laptop.

## 0. Prerequisites

| What | Why | Where it is enforced |
| --- | --- | --- |
| Public HTTPS API origin, e.g. `https://api.reygent.com` | Shopify must be able to POST deliveries to it | `APP_URL` is validated at boot: `https`-only, not a tunnel host, not local, and inside `APP_DOMAIN` (`src/config/environment.ts`) |
| `APP_DOMAIN=reygent.com` | Distinguishes this app's subscriptions from other integrations' on the same store | `src/shopify/webhook-registration.ts` |
| `ENCRYPTION_KEY` | Encrypts access tokens at rest | Store tokens cannot be decrypted if this changes — reconnect instead of swapping keys |
| `DATABASE_URL` (owner) for admin scripts, `APP_DATABASE_URL` (restricted role) for the app | Row-level security is bypassed by the owner only; the app role must be tenant-scoped | `docker/postgres-init/01-create-app-role.sql`, `src/prisma/prisma.service.ts` |
| Redis reachable from the API | Webhook intake queues the delivery before acknowledging | `src/webhooks/webhook-intake.service.ts` |
| `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` | Only needed for Route A (OAuth) | `src/shopify/shopify-auth.service.ts` |
| `SHOPIFY_WEBHOOK_SECRET` | Fallback signing secret for stores without their own — for Route B, store the secret per store instead | `src/webhooks/webhook-intake.service.ts` |

Confirm the deployment is healthy before touching Shopify:

```sh
curl -s https://api.reygent.com/health
```

---

## 1a. Route A — OAuth app install (multi-tenant, the SaaS route)

Use this when more than one merchant will install the same app, or when the
store should grant/revoke access itself.

1. **Create the app** in the [Partner Dashboard](https://partners.shopify.com)
   → *Apps* → *Create app*.
   - **App URL:** the API origin — `https://api.reygent.com/` in production, or
     the `APP_URL` of the environment you are installing into. On the
     single-host development topology that is the dashboard host
     (`https://oms.reygent.com/`); the install entry and callback are
     rewritten through to the API, as described under *Hosts and origins*.
   - **Allowed redirection URL:** `<APP_URL>/auth/shopify/callback`, e.g.
     `https://api.reygent.com/auth/shopify/callback`.
2. **Copy the client credentials** into the deployment environment — the
   **Client ID** and **Client secret** from the app's credentials page:

   ```sh
   SHOPIFY_API_KEY=<client id>
   SHOPIFY_API_SECRET=<client secret>
   SHOPIFY_SCOPES=read_orders,read_products,read_inventory
   ```

   The client secret plays two roles for this app: it validates the signed
   install/callback requests (`SHOPIFY_API_SECRET`) and it is the secret
   Shopify signs webhook deliveries with. A store that has its own stored
   secret wins over `SHOPIFY_WEBHOOK_SECRET` (Route B stores one per store);
   for an OAuth app, where one app serves every store, the client secret *is*
   the fallback — set `SHOPIFY_WEBHOOK_SECRET` to the same value and every
   installed store verifies out of the box.

   Restart the API. A bad `APP_URL`/`APP_DOMAIN` pair fails at boot rather
   than at the first delivery.
3. **Install it on a store.** Shopify must be the one to open your App URL:
   from the Partner Dashboard choose *Test on a development store*, or send
   the merchant the install link the dashboard generates.
   - Shopify opens `https://api.reygent.com/?shop=<shop>.myshopify.com&hmac=…&timestamp=…`
   - `validateInstallRequest` verifies the HMAC against `SHOPIFY_API_SECRET`
     and rejects anything older than **5 minutes**.
   - Opening that URL by hand returns `401 Invalid Shopify installation
     signature`. That is expected — the link has to come from Shopify.
4. **Complete the callback.** Shopify redirects to
   `/auth/shopify/callback?code=…&state=…`; the API verifies the signed state,
   exchanges the code for an access token, encrypts it, flips the store to
   `ACTIVE`, and — on the first install for that shop — issues a **tenant API
   key, shown exactly once**. Save it; every API call for that store uses
   `Authorization: Bearer <key>`.
5. Continue with **step 2** (register webhooks) and **step 3** (map the store's SKUs).

For App Store distribution, also set the three mandatory privacy webhooks —
*Customer data request*, *Customer data erasure*, *Shop data erasure* — all
pointing at `https://api.reygent.com/webhooks/shopify`. They are configured in
the **Partner Dashboard / Dev Dashboard** (or `compliance_topics` in
`shopify.app.toml`), because **Shopify refuses to create them through the Admin
API**. The API already answers them (see *Compliance* below).

---

## 1b. Route B — Custom app token (fastest for one store)

Use this for a pilot, an internal deployment, or a dev/staging store where
issuing an OAuth app is overkill.

1. In Shopify admin: **Settings → Apps and sales channels → Develop apps →
   Create an app**.
2. **Configure Admin API scopes.** Webhook registration and payloads are
   gated per topic, not by a global "webhooks" scope, so pick:

   | Scope | Needed for |
   | --- | --- |
   | `read_orders` | `orders/create`, `orders/updated`, `orders/cancelled` (orders older than 60 days need the separately approved `read_all_orders`) |
   | `read_products` | product/variant data referenced by line items |
   | `read_inventory` | stock levels; add `write_inventory` when the OMS should push stock to Shopify |
   | `write_orders` (later) | fulfilment/tracking write-back — Phase 1 work; the inventory client already checks granted scopes before writing |

   `app/uninstalled` needs no topic scope of its own.
3. **Install app**, then copy **two** values:
   - the **Admin API access token** (`shpat_…`) — shown once; if you lose it,
     uninstall and reinstall;
   - the **API secret key** — this is what signs webhook deliveries, and
     `--webhook-secret` stores it against the store.

   Skipping the second one "works" only while the deployment serves a single
   custom app: without a stored secret, deliveries are verified against the
   deployment-wide `SHOPIFY_WEBHOOK_SECRET`. Connect a second custom app and
   its deliveries would be rejected (401) — and Shopify deletes a
   subscription that keeps failing, so orders stop arriving quietly.
4. Connect it:

   ```sh
   npx ts-node connect-shopify-store.ts \
     --shop=techmart-lab.myshopify.com \
     --token=shpat_xxxxxxxxxxxxxxxxxxxx \
     --webhook-secret=<API secret key> \
     --dry-run
   ```

   The script, in order:
   - validates the shop domain;
   - **verifies the token** with a live `shop` query and reads back the
     granted scopes, warning about scopes the OMS expects (`--skip-verify`
     only if Shopify is unreachable from where you run it — it stores the
     token unverified);
   - resolves the tenant: `--tenant-id`, else the tenant that already owns
     that shop domain, else a new tenant named after the shop (a new tenant
     also gets a tenant API key, printed once);
   - refuses to move an existing store to a different tenant;
   - upserts the `StoreConnection` as `ACTIVE` with the token and the webhook
     secret **encrypted** (`ENCRYPTION_KEY`); plaintext is never stored or
     logged (`--webhook-secret` can also come from `SHOPIFY_WEBHOOK_SECRET`);
   - re-running without `--webhook-secret` keeps the stored one, so rotating
     the access token does not drop webhook verification.

   Drop `--dry-run` to apply. Re-running it later is how you rotate a token
   or recover after an uninstall.

5. Check the result:

   ```sh
   npx ts-node verify-shopify-store-token.ts --shop=techmart-lab.myshopify.com
   ```

   It reports the connection status, confirms the stored ciphertext still
   decrypts with the current `ENCRYPTION_KEY`, calls Shopify with the real
   token, and lists the granted scopes (`--offline` skips the Shopify call).
   Exit code 1 means a message explaining what to fix.

6. Continue with **step 2** (register webhooks) and **step 3** (map the store's
   SKUs — without that, the first real order cannot reserve stock).

---

## 2. Register webhooks (once per store, per environment)

```sh
# See the plan first — it changes nothing.
npx ts-node shopify-register-orders-webhook.ts --shop=techmart-lab.myshopify.com --dry-run

# Then apply it.
npx ts-node shopify-register-orders-webhook.ts --shop=techmart-lab.myshopify.com
```

What it registers, against `<APP_URL>/webhooks/shopify`:

| Topic | Why |
| --- | --- |
| `ORDERS_CREATE` | New order → order, line items, stock reservation |
| `ORDERS_UPDATED` | Edits → re-allocation of reserved stock |
| `ORDERS_CANCELLED` | Cancellation → release reservations (reversible, ledgered) |
| `APP_UNINSTALLED` | Merchant removed the app → stop treating the connection as live and clear the token |

Behaviour worth knowing:

- It **reconciles** instead of appending: it creates missing topics, moves
  subscriptions that are ours (same host, another host under `APP_DOMAIN`, or
  a leftover tunnel URI) onto the current `APP_URL`, deletes duplicate
  registrations of that URI, and reports anything else as `unmanaged` without
  touching it.
- A tunnel/local `APP_URL` is refused outside `--allow-tunnel`, which itself
  is for development only. Production rules are not overridable.
- Deliveries are verified with the secret stored for that store; only when a
  store has none does the deployment-wide `SHOPIFY_WEBHOOK_SECRET` apply (the
  right default for an OAuth app, where one app secret signs every store). A
  failed signature is rejected with 401 **before** the payload is stored, so
  unauthenticated data never becomes replayable work.
- **The three privacy topics cannot be registered here** — Shopify only
  accepts them via app configuration / Dev Dashboard, and admin-created custom
  apps cannot use app configuration at all. Passing `--include-compliance`
  therefore fails with that explanation instead of quietly registering part of
  what you asked for.
- API-created (shop-specific) subscriptions are **deleted by Shopify when they
  keep failing**; subscriptions declared in app configuration are not. That is
  one more reason the URI in `APP_URL` has to be a stable, deployed origin.

> Subscriptions live on **Shopify's side, per store** — not per environment.
> Pointing a development tunnel at a store that production also uses silently
> re-registers the live store's webhooks to a laptop. Use a dev store and a
> dev app.

---

## 3. Map the store's SKUs (before real orders)

An `orders/create` delivery becomes a reservation by looking each line item's
**SKU** up in the tenant's inventory catalogue (`InventoryItem`, unique per
tenant + SKU). A store that has just been connected has none of those rows, so
the first real order does **not** reserve stock — it is stored as an order with
status `FAILED` and raises a HIGH exception:

> Order #1002 references unknown SKU TSHIRT-BLACK-M

Nothing is lost (order, line items, exception, and audit trail are all stored;
the delivery itself is `PROCESSED`), but no stock is held and the order needs a
human. Map the SKUs before a live store points at the OMS:

```sh
# What is in the catalogue, what is mapped, and what is missing?
npx ts-node map-shopify-sku.ts --shop=<shop>.myshopify.com --list

# Ensure a SKU exists (creates the item plus a stock balance at the tenant's
# default location) and record its Shopify inventory item id.
npx ts-node map-shopify-sku.ts --shop=<shop>.myshopify.com \
  --sku=TSHIRT-BLACK-M --name="Black Tee (M)" --qty=25 \
  --shopify-inventory-item-id=gid://shopify/InventoryItem/1234567890
```

- `--sku` must equal the SKU on the Shopify **variant** — that string is the
  join key in both directions.
- `--qty` sets on-hand stock (absolute value; the change is written through the
  movement ledger as an `ADJUSTMENT_IN`/`ADJUSTMENT_OUT` delta, never by
  rewriting history).
- `--shopify-inventory-item-id` is only needed for the *outbound* direction
  (pushing stock to Shopify). Inbound order intake does not consult it.
- `--location-id` is required when the tenant has more than one active
  inventory location; a tenant with none gets a `DEFAULT` location created.
- `--list` flags each item with `reservationReady` — an inactive item or one
  with zero available stock will still raise an exception.
- `--remove` drops a mapping without touching stock; `--dry-run` prints the
  plan. Every write is audited: `INVENTORY_ITEM_CREATED`,
  `SKU_MAPPED_TO_SHOPIFY`, `SKU_UNMAPPED_FROM_SHOPIFY`.

A SKU discovered *after* a failed order can be repaired: map it, then
re-deliver — a fresh delivery (or a touch in Shopify, which sends
`orders/updated`) re-syncs the order idempotently and the reservation is made.

---

## 4. Prove it works

1. **Send a real delivery.** Place an order (Shopify admin → Orders →
   *Create order*), or in local development replay a signed fixture:

   ```sh
   npx ts-node replay-shopify-webhook.ts \
     --topic=orders/create --shop=<shop>.myshopify.com \
     --fixture=fixtures/shopify-webhooks/orders-create.json
   ```

   The replay tool signs with the same secret the intake will verify — the
   store's stored secret when it has one, otherwise
   `SHOPIFY_WEBHOOK_SECRET` — and prints which one it used.

2. **Watch the intake.** Every delivery is stored before it is acknowledged:

   ```sql
   select topic, status, attempts, "lastError", "receivedAt"
   from "WebhookEvent" order by "receivedAt" desc limit 10;
   ```

   Expected: one row per delivery, `PROCESSED`, no `lastError`.
3. **Check the result in the OMS.** The order appears in
   `GET /oms/orders?storeId=<storeConnectionId>` and on the dashboard's
   orders page; stock movements and reservations are visible on the
   inventory page.
4. **Test a re-delivery.** Shopify retries duplicates; re-running the same
   fixture produces the same deterministic event id and does **not** create a
   second order.
5. **Test the failure path.** With Redis stopped, a signed delivery is stored
   as `FAILED` with a reason and the API answers `503` so Shopify retries.
   Re-send stored work after Redis is back:

   ```sh
   npx ts-node replay-shopify-webhook.ts --from-event=<webhookEventId>
   ```

### What a first real order should look like

| Where | Mapped SKU (section 3 done) | Unmapped SKU |
| --- | --- | --- |
| HTTP answer to Shopify | `202 {accepted: true}` | same — the delivery itself is fine |
| `WebhookEvent` | `PROCESSED`, no `lastError` | `PROCESSED` |
| `Order` | `NEW`, `paymentStatus` from the payload | `FAILED` |
| `InventoryReservation` | `ACTIVE`, quantity as ordered | none |
| `InventoryBalance` | available ↓ / reserved ↑ by that quantity | unchanged |
| `OperationalException` | none | HIGH `ORDER_OPERATIONAL_RISK` "references unknown SKU …" |
| `AuditEvent` | `WEBHOOK_PROCESSING_STARTED` → `ORDER_SYNCED_FROM_SHOPIFY` → `WEBHOOK_PROCESSED` | `WEBHOOK_BUSINESS_FAILURE_HANDLED` + `MANUAL_INVESTIGATION_REQUIRED` |

The unmapped case is a *business* outcome, not a bug: the delivery stays
`PROCESSED`, the order and the reason are stored, and the autonomous-recovery
step records `MANUAL_INVESTIGATION_REQUIRED` so a human decides. Fix it by
mapping the SKU (section 3) and re-delivering.

### What each HTTP answer means

| Status | Meaning |
| --- | --- |
| `202` | Stored and queued — or an already-processed duplicate (`duplicate: true`) |
| `400` | Malformed delivery: a missing `X-Shopify-*` header, or a body that is not JSON |
| `401` | Signature did not match the secret stored for that store; nothing was stored |
| `503` | Stored, but queueing exceeded `WEBHOOK_ENQUEUE_TIMEOUT_MS` (typically Redis down). Shopify retries; the row stays `FAILED` and can be replayed |
| `405` | A browser (or probe) opened the URL with `GET`. Shopify only ever `POST`s here; this JSON is how you know the request really reached this app |

---

## Lifecycle: uninstall, reconnect, compliance

- **Uninstall** (`app/uninstalled`) — the store is set `DISCONNECTED`, its
  encrypted access token is cleared, and a `STORE_DISCONNECTED` audit event is
  recorded. Order deliveries that arrive afterwards are acknowledged and
  marked `WEBHOOK_IGNORED` with the reason, instead of being processed against
  a dead connection. The Shopify-side subscriptions disappear with the
  install, so no cleanup is needed there.
- **Reconnect** — rerun the Route B connect command with a fresh token, or
  reinstall the OAuth app. The same tenant, store row, and history are reused;
  the store returns to `ACTIVE`.
- **Compliance** (`customers/data_request`, `customers/redact`,
  `shop/redact`) — the API acknowledges, records a
  `COMPLIANCE_REQUEST_RECEIVED` audit event, and raises a **HIGH**
  `COMPLIANCE` exception so the 30-day Shopify window cannot be missed
  silently. This still happens after an uninstall, because a merchant's data
  rights outlive the install. Topics are matched by their REST names
  (`customers/data_request`, `customers/redact`, `shop/redact`), with the
  GraphQL spellings (`CUSTOMERS_DATA_REQUEST`, …) normalized to them, so a
  delivery can never fall through the handler because of how it was spelled. A
  test asserts that every compliance topic the app can register also has a
  handler. Performing the export/erasure itself is tenant data-governance work
  tracked in `docs/ROADMAP.md` (Phase 3). Performing the export/erasure itself is tenant
  data-governance work tracked in `docs/ROADMAP.md` (Phase 3).

  **Which installs actually receive these requests:**
  - Route A, distributed app: yes — the topics are configured in the Partner
    Dashboard / `shopify.app.toml`, and Shopify delivers them.
  - Route B, admin-created custom app: **no** — Shopify does not allow custom
    apps to subscribe to compliance topics, so nothing is delivered and the
    handling above is never exercised. Handle data requests for that store out
    of band (mailbox plus the audit trail in the OMS) until the store moves to
    Route A.

---

## Local development (no public origin)

A local API cannot receive real deliveries: `APP_URL=http://localhost:4000`
is not reachable from Shopify, and localhost/tunnel origins are rejected in
production by design.

- **Default:** replay signed fixtures through the real intake
  (`replay-shopify-webhook.ts`) — same signing, same code path as production.
- **If you need real deliveries from a real store:** run a Cloudflare Tunnel
  with a stable hostname (`oms.reygent.com` → the dashboard, per *Hosts and
  origins* above), set `APP_URL=https://oms.reygent.com` with
  `NODE_ENV=development`, and use a dedicated dev app and dev store — never a
  production store. `--allow-tunnel` is only for temporary, non-domain
  hostnames; `oms.reygent.com` is a normal on-domain host and needs no flag.
- **Redis must be running** for the happy path. Without it, deliveries are
  still stored (marked `FAILED`) and can be re-driven once Redis is up.

### Is the tunnel actually reaching this app?

A hostname can resolve and still not route anywhere: a Cloudflare Tunnel only
forwards hostnames it has an ingress / **Public hostname** rule for, and
anything else gets cloudflared's own catch-all — a plain-text
`404 page not found`, which looks nothing like a response from this app. Three
checks, from any machine with internet access, tell the two apart:

```sh
# 1. Dashboard (the tunnel's origin): expect HTML.
curl -s -o /dev/null -w '%{http_code}\n' https://oms.reygent.com/

# 2. Dashboard → API rewrite: expect {"status":"ok"}.
curl -s https://oms.reygent.com/api/health

# 3. The webhook endpoint: a browser GET must answer 405 with JSON, and an
#    empty POST must answer 400 — both are success.
curl -s https://oms.reygent.com/webhooks/shopify
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'content-type: application/json' -d '{}' \
  https://oms.reygent.com/webhooks/shopify
```

Any plain-text `404 page not found` means the request never reached this stack:
add the hostname to the tunnel (`cloudflared` ingress rule or Zero Trust →
Networks → Tunnels → Public hostnames → `oms.reygent.com` → `http://localhost:3000`),
and make sure the dashboard (and API, Postgres, Redis) are running on the machine
the tunnel is attached to. Note that only the **laptop/host running cloudflared**
is reachable from Shopify — a tunnel cannot reach a different machine's
`localhost`.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `401 Invalid Shopify installation signature` when opening the app URL | The URL was opened by hand instead of by Shopify, or `SHOPIFY_API_SECRET` belongs to a different app | Use the install link from the Partner Dashboard; make sure the key/secret pair is from the same app |
| `Expired Shopify installation request` | The install link is older than 5 minutes | Click **Install** again |
| `401` on `POST /webhooks/shopify`, log says *store-specific secret* | The stored secret does not match the app's API secret key (typical after rotating it in Shopify) | Re-run `connect-shopify-store.ts --webhook-secret=<new key>`; nothing is stored for a failed signature, so re-send the delivery afterwards |
| `401`, log says *deployment-wide SHOPIFY_WEBHOOK_SECRET* | The store has no stored secret and the env secret is not this app's API secret key | Connect with `--webhook-secret=<key>` (preferred), or set `SHOPIFY_WEBHOOK_SECRET` when one app serves every store |
| `401 Unknown Shopify shop` | Delivery for a shop domain with no `StoreConnection` | Connect that store first; with no store there is no secret to verify against, so nothing is stored |
| `503` from the webhook endpoint, rows in `FAILED` | Redis unreachable, or queueing slower than `WEBHOOK_ENQUEUE_TIMEOUT_MS` | Start Redis / raise the timeout, then replay `--from-event=<id>` |
| Order stored as `FAILED` with `ORDER_OPERATIONAL_RISK` "references unknown SKU …" | The line item's SKU has no `InventoryItem` for that tenant — every freshly connected store starts like this | Map the SKUs (section 3), then re-deliver the order |
| `400 Required Shopify webhook headers are missing` / `400 Invalid JSON webhook payload` | The request is not a Shopify delivery (a probe, a wrong content type, a truncated body) | Expected client error, not an outage; a real delivery always carries `X-Shopify-Topic`, `X-Shopify-Shop-Domain`, `X-Shopify-Webhook-Id`, `X-Shopify-Hmac-Sha256` |
| `map-shopify-sku.ts --list` shows `reservationReady: false` | The item is inactive, or has zero available stock at its location | Set stock with `--qty=<n>` (or reactivate the item) before the next order |
| `Shopify inventory item … is already mapped to SKU …` | Two OMS SKUs claim the same Shopify inventory item | Decide which SKU owns it; `--remove` the wrong mapping first |
| Orders never appear, events show `WEBHOOK_IGNORED` | The store is not `ACTIVE` (typically after an uninstall) | Reconnect the store, then resend the delivery |
| Opening `/webhooks/shopify` in a browser returns plain-text `404 page not found` | That body is cloudflared's catch-all for a hostname with no ingress rule — the request is not reaching this app | Add the Public hostname (see *Is the tunnel actually reaching this app?*); from this app a browser GET answers `405` JSON |
| A subscription's URI points at a dead tunnel | A dev environment registered its tunnel on a shared store | Rerun the registration script from the environment you want the store to use |
| `verify-shopify-store-token.ts` cannot decrypt the token | `ENCRYPTION_KEY` changed, or you are pointing at another environment's database | Reconnect the store with the correct key |
| `fetch failed` in any of the scripts | No outbound network to `*.myshopify.com` (locked-down CI, sandbox, proxy) | Run from a host that can reach Shopify's Admin API |
| `webhookSubscriptionCreate` returns `Access denied for webhookSubscriptionCreate` | The custom app was not granted the scope for that topic (`read_orders` for orders/*) | Add the scope in the app's *Configure Admin API scopes*, click **Install app** again, and copy the **new** token — changing scopes issues a new token |
| `--include-compliance` fails immediately | Not implemented by accident — Shopify rejects these topics via the Admin API | Configure them in the Partner Dashboard / Dev Dashboard (Route A); a custom app cannot subscribe to them at all |
| An unknown topic is stored and marked `PROCESSED` | Topics outside the managed set (`orders/fulfilled`, `inventory_levels/update`, …) are acknowledged but not acted on yet | Expected until the Phase 1 fulfilment/write-back work lands; tracked in `docs/ROADMAP.md` |

---

## Code map

| Concern | File |
| --- | --- |
| Install/callback validation, token exchange | `src/shopify/shopify-auth.service.ts`, `shopify-auth.controller.ts`, `shopify-query-hmac.ts` |
| Token encryption at rest | `src/shopify/shopify-auth.crypto.ts` |
| Which topics are managed, and how they are reconciled | `src/shopify/webhook-registration.ts` |
| Durable intake (per-store signature check, store-then-ack, bounded queueing) | `src/webhooks/webhook-intake.service.ts` |
| Topic handling (orders, uninstall, compliance) | `src/webhooks/webhook-processor/webhook-processor.service.ts` |
| Operator tooling | `connect-shopify-store.ts`, `verify-shopify-store-token.ts`, `map-shopify-sku.ts` (SKU ↔ catalogue, with audit trail), `shopify-register-orders-webhook.ts`, `replay-shopify-webhook.ts` (the last signs with the store's own secret) |
| Tests for the rules above | `src/shopify/webhook-registration.spec.ts`, `src/webhooks/webhook-processor/webhook-processor.service.spec.ts`, `src/webhooks/webhook-intake.service.spec.ts` |

import "dotenv/config";
import { PrismaClient } from "@prisma/client";

import { encryptSecret } from "./src/shopify/shopify-auth.crypto";
import { isValidShopDomain } from "./src/shopify/shopify-query-hmac";
import { TenantApiKeyService } from "./src/auth/tenant-api-key.service";
import {
  createPrismaAdapter,
  databaseUrlFromEnv,
} from "./src/prisma/prisma-adapter";
import type { PrismaService } from "./src/prisma/prisma.service";

/**
 * Connects a Shopify store to this OMS using a **custom app** Admin API
 * access token — the fastest route for a single store during development,
 * a pilot, or an internal deployment where the OAuth app is not published
 * yet. For a multi-tenant SaaS install, use the OAuth flow instead:
 * `GET ${APP_URL}/?shop=<shop>.myshopify.com` (see README).
 *
 * Usage:
 *   npx ts-node connect-shopify-store.ts \
 *     --shop=techmart-lab.myshopify.com \
 *     --token=shpat_xxxxxxxxxxxxxxxx \
 *     --webhook-secret=<the app's API secret key> \
 *     [--tenant-id=<uuid>] [--scopes=read_orders,read_products,read_inventory] \
 *     [--label="pilot store"] [--skip-verify] [--dry-run]
 *
 * The token can also come from SHOPIFY_ADMIN_ACCESS_TOKEN and the secret from
 * SHOPIFY_WEBHOOK_SECRET.
 *
 * **Pass the webhook secret.** Webhook deliveries are signed with the custom
 * app's API secret key, and the intake verifies them per store. Without a
 * stored secret every delivery for this store is checked against the
 * deployment-wide SHOPIFY_WEBHOOK_SECRET, which is only correct when one app
 * serves every store (an OAuth app) — with a second admin-created custom app
 * it means rejected deliveries (401) and eventually a subscription Shopify
 * deletes.
 *
 * What it does, in order:
 *   1. validates the shop domain and that the token actually works (a live
 *      `shop` query), reading back the granted access scopes;
 *   2. resolves the tenant: `--tenant-id`, else the tenant already owning
 *      this shop domain, else a new tenant named after the shop (a new
 *      tenant also gets a tenant API key, shown once);
 *   3. upserts the StoreConnection as ACTIVE with the token encrypted using
 *      ENCRYPTION_KEY (the plaintext token is never stored);
 *   4. prints the next steps: register webhooks, then send a test order.
 *
 * Nothing here is destructive: re-running it rotates the stored token for
 * an existing connection (which is also how you recover from a token that
 * was revoked or from an earlier uninstall).
 */

const ADMIN_API_VERSION = "2026-07";

type Options = {
  shopDomain?: string;
  token?: string;
  webhookSecret?: string;
  tenantId?: string;
  scopes?: string;
  label?: string;
  skipVerify: boolean;
  dryRun: boolean;
};

function parseArguments(argv: string[]) {
  const flags = new Set(
    argv.filter((a) => a.startsWith("--") && !a.includes("=")),
  );
  const values = new Map<string, string>();

  for (const argument of argv) {
    const match = argument.match(/^--([^=]+)=(.*)$/);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      values.set(match[1], match[2]);
    }
  }

  return { flags, values };
}

function readOptions(argv: string[]): Options {
  const { flags, values } = parseArguments(argv);

  return {
    shopDomain: (values.get("shop") ?? process.env.SHOPIFY_SHOP_DOMAIN)?.trim(),
    token: (values.get("token") ?? process.env.SHOPIFY_ADMIN_ACCESS_TOKEN)?.trim(),
    webhookSecret: (values.get("webhook-secret") ?? process.env.SHOPIFY_WEBHOOK_SECRET)?.trim(),
    tenantId: values.get("tenant-id")?.trim(),
    scopes: values.get("scopes")?.trim(),
    label: values.get("label")?.trim(),
    skipVerify: flags.has("--skip-verify"),
    dryRun: flags.has("--dry-run"),
  };
}

function fail(message: string): never {
  throw new Error(message);
}

const prisma = new PrismaClient({
  adapter: createPrismaAdapter(
    databaseUrlFromEnv(["DATABASE_URL", "APP_DATABASE_URL"]),
  ),
});

type ShopProbe = {
  name: string | null;
  grantedScopes: string[];
};

async function probeShop(shop: string, token: string): Promise<ShopProbe> {
  let response: Response;

  try {
    response = await fetch(
      `https://${shop}/admin/api/${ADMIN_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: JSON.stringify({
          query: `{ shop { name myshopifyDomain currencyCode } currentAppInstallation { accessScopes { handle } } }`,
        }),
      },
    );
  } catch (error) {
    fail(
      `Could not reach https://${shop}/admin/api/${ADMIN_API_VERSION}/graphql.json (${
        error instanceof Error ? error.message : String(error)
      }). Check the shop domain and outbound network access to Shopify; pass --skip-verify only if you accept storing an unverified token.`,
    );
  }

  const body = (await response.json().catch(() => ({}))) as any;

  if (response.status === 401 || response.status === 403) {
    fail(
      `Shopify rejected the token (HTTP ${response.status}). Check that the custom app is installed on ${shop} and that the token was copied completely.`,
    );
  }

  if (!response.ok) {
    fail(`Shopify returned HTTP ${response.status} while verifying the token.`);
  }

  if (body?.errors?.length) {
    fail(
      `Shopify GraphQL errors: ${body.errors
        .map((error: { message: string }) => error.message)
        .join("; ")}`,
    );
  }

  return {
    name: body?.data?.shop?.name ?? null,
    grantedScopes: (body?.data?.currentAppInstallation?.accessScopes ?? []).map(
      (scope: { handle: string }) => scope.handle,
    ),
  };
}

/** Warns (does not fail) when the token lacks scopes the OMS relies on. */
function scopeWarnings(granted: string[], requested: string): string[] {
  if (granted.length === 0) return [];

  const wanted = requested
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);

  return wanted
    .filter((scope) => !granted.includes(scope))
    .map(
      (scope) =>
        `token is missing scope "${scope}" — order sync, inventory reads, or webhook registration may fail`,
    );
}

async function main() {
  const options = readOptions(process.argv.slice(2));

  if (!options.shopDomain) {
    fail(
      "Usage: npx ts-node connect-shopify-store.ts --shop=<shop>.myshopify.com --token=<admin-api-token> [--tenant-id=<uuid>]",
    );
  }

  const shop = options.shopDomain.toLowerCase();

  if (!isValidShopDomain(shop)) {
    fail(`Not a valid Shopify shop domain: ${shop}`);
  }

  const encryptionKey = process.env.ENCRYPTION_KEY;

  if (!encryptionKey) fail("ENCRYPTION_KEY is not configured");

  if (!options.token) {
    fail(
      "No token provided. Pass --token=<admin-api-token> or set SHOPIFY_ADMIN_ACCESS_TOKEN.",
    );
  }

  const requestedScopes =
    options.scopes ??
    process.env.SHOPIFY_SCOPES ??
    "read_orders,read_products,read_inventory";

  let probe: ShopProbe = { name: null, grantedScopes: [] };

  if (options.skipVerify) {
    console.warn(
      "! Skipping token verification (--skip-verify): the connection will look ACTIVE even if the token is invalid.",
    );
  } else {
    probe = await probeShop(shop, options.token);
    console.log(
      `Verified ${shop}${probe.name ? ` (${probe.name})` : ""} — granted scopes: ${
        probe.grantedScopes.join(", ") || "not reported"
      }`,
    );

    for (const warning of scopeWarnings(probe.grantedScopes, requestedScopes)) {
      console.warn(`! ${warning}`);
    }
  }

  const existing = await prisma.storeConnection.findUnique({
    where: {
      platform_externalStoreId: {
        platform: "SHOPIFY",
        externalStoreId: shop,
      },
    },
    select: { id: true, tenantId: true, status: true },
  });

  let tenantId = options.tenantId ?? existing?.tenantId;

  if (options.tenantId && existing && existing.tenantId !== options.tenantId) {
    fail(
      `Store ${shop} already belongs to tenant ${existing.tenantId}; refusing to move it to ${options.tenantId}. Disconnect it first if that is really intended.`,
    );
  }

  let tenantName: string | null = null;

  if (tenantId) {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    });

    if (!tenant) fail(`No tenant found with id ${tenantId}`);

    tenantName = tenant.name;
  }

  const encryptedAccessToken = encryptSecret(options.token, encryptionKey);
  const encryptedWebhookSecret = options.webhookSecret
    ? encryptSecret(options.webhookSecret, encryptionKey)
    : null;

  if (!options.webhookSecret && !existing) {
    console.warn(
      [
        "! No --webhook-secret was given. Deliveries will be verified with the",
        "  deployment-wide SHOPIFY_WEBHOOK_SECRET, which must then be exactly this",
        "  custom app's API secret key. Re-run with --webhook-secret=<key> to store",
        "  it per store instead (required once a second custom app is connected).",
      ].join("\n"),
    );
  }
  const scopes = probe.grantedScopes.length
    ? probe.grantedScopes
    : requestedScopes.split(",").map((scope) => scope.trim()).filter(Boolean);

  if (options.dryRun) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          shopDomain: shop,
          action: existing ? "would update existing connection" : "would create connection",
          existingStatus: existing?.status ?? null,
          tenant: tenantId ? { id: tenantId, name: tenantName } : "would create a new tenant",
          scopes,
        },
        null,
        2,
      ),
    );
    return;
  }

  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);

    let resolvedTenantId = tenantId;

    if (!resolvedTenantId) {
      const tenant = await tx.tenant.create({
        data: { name: probe.name ?? shop },
        select: { id: true, name: true },
      });

      resolvedTenantId = tenant.id;
      tenantName = tenant.name;
    }

    const store = await tx.storeConnection.upsert({
      where: {
        platform_externalStoreId: {
          platform: "SHOPIFY",
          externalStoreId: shop,
        },
      },
      create: {
        tenantId: resolvedTenantId,
        platform: "SHOPIFY",
        externalStoreId: shop,
        status: "ACTIVE",
        encryptedAccessToken,
        encryptedWebhookSecret,
        scopes,
        installedAt: new Date(),
      },
      update: {
        tenantId: resolvedTenantId,
        platform: "SHOPIFY",
        status: "ACTIVE",
        encryptedAccessToken,
        // Only overwrite an existing stored secret when a new one is given,
        // so re-running to rotate the token does not silently drop it.
        ...(encryptedWebhookSecret ? { encryptedWebhookSecret } : {}),
        scopes,
        installedAt: new Date(),
        disconnectedAt: null,
      },
      select: { id: true, externalStoreId: true, status: true, tenantId: true },
    });

    return { store, tenantId: resolvedTenantId };
  });

  let apiKey: string | null = null;

  if (!existing) {
    const service = new TenantApiKeyService(prisma as unknown as PrismaService);
    const issued = await service.issueKey({
      tenantId: result.tenantId,
      label: options.label ?? `${shop} — custom app connection`,
    });

    apiKey = issued.rawKey;
  }

  console.log(
    JSON.stringify(
      {
        connected: true,
        shopDomain: result.store.externalStoreId,
        storeConnectionId: result.store.id,
        status: result.store.status,
        tenant: { id: result.tenantId, name: tenantName },
        scopes,
        webhookSecret: options.webhookSecret
          ? "stored (encrypted, per store)"
          : "not stored — falls back to SHOPIFY_WEBHOOK_SECRET",
        apiKeyIssued: apiKey ? "yes (shown below, save it now)" : "no (existing tenant)",
      },
      null,
      2,
    ),
  );

  if (apiKey) {
    console.log(`\nTenant API key (shown once):\n\n${apiKey}\n`);
  }

  console.log(
    [
      "Next steps:",
      `  1. Register webhooks:  npx ts-node shopify-register-orders-webhook.ts --shop=${shop} --dry-run`,
      "  2. Re-run the same command without --dry-run once the plan looks right.",
      "  3. Map the store's SKUs so orders can reserve stock:",
      `       npx ts-node map-shopify-sku.ts --shop=${shop} --list`,
      "  4. Send a test order, or replay a signed fixture:",
      "       npx ts-node replay-shopify-webhook.ts --topic=orders/create --fixture=fixtures/shopify-webhooks/orders-create.json",
      "  5. Confirm the event is PROCESSED and the order appears: GET /oms/orders?storeId=<storeConnectionId>",
    ].join("\n"),
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

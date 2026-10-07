import "dotenv/config";
import { PrismaClient } from "@prisma/client";

import { decryptSecret } from "./src/shopify/shopify-auth.crypto";
import { isValidShopDomain } from "./src/shopify/shopify-query-hmac";
import {
  createPrismaAdapter,
  databaseUrlFromEnv,
} from "./src/prisma/prisma-adapter";

/**
 * End-to-end check of one store connection. Answers the question that
 * matters after connecting a store or before blaming the OMS for missing
 * orders: *is this token still valid, and what may we actually read with it?*
 *
 * Usage:
 *   npx ts-node verify-shopify-store-token.ts --shop=<shop>.myshopify.com [--offline]
 *
 * `--offline` skips the Shopify call and only checks the local record
 * (status, ciphertext, whether ENCRYPTION_KEY can still decrypt it) — useful
 * from a machine with no outbound access, e.g. a locked-down CI runner.
 *
 * Run it with DATABASE_URL (the migration/admin role). Reading a store
 * before a tenant is known is one of the deliberate `app.bypass_rls`
 * cases; the restricted app role would correctly see nothing here.
 *
 * Exit codes: 0 = connection healthy, 1 = problem found (the message says
 * which one). Safe to run repeatedly; it writes nothing.
 */

const ADMIN_API_VERSION = "2026-07";
const EXPECTED_SCOPES = ["read_orders", "read_products", "read_inventory"];

const prisma = new PrismaClient({
  adapter: createPrismaAdapter(
    databaseUrlFromEnv(["DATABASE_URL", "APP_DATABASE_URL"]),
  ),
});

function parseArguments(argv: string[]) {
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (const argument of argv) {
    const match = argument.match(/^--([^=]+)=(.*)$/);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      values.set(match[1], match[2]);
    } else if (argument.startsWith("--")) {
      flags.add(argument.slice(2));
    }
  }

  return {
    shopDomain: (values.get("shop") ?? process.env.SHOPIFY_SHOP_DOMAIN)?.trim(),
    offline: flags.has("offline"),
  };
}

type ShopProbe = { name: string | null; grantedScopes: string[] };

async function probeShop(shop: string, token: string): Promise<ShopProbe> {
  const response = await fetch(
    `https://${shop}/admin/api/${ADMIN_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({
        query: `{ shop { name myshopifyDomain } currentAppInstallation { accessScopes { handle } } }`,
      }),
    },
  );

  const body = (await response.json().catch(() => ({}))) as any;

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `Shopify rejected the stored token (HTTP ${response.status}). The app was probably uninstalled, or the token was revoked/rotated — reconnect the store (connect-shopify-store.ts, or reinstall the OAuth app).`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `Shopify returned HTTP ${response.status} for the token check.`,
    );
  }

  if (body?.errors?.length) {
    throw new Error(
      `Shopify GraphQL errors: ${body.errors
        .map((error: { message: string }) => error.message)
        .join("; ")}`,
    );
  }

  return {
    name: body?.data?.shop?.name ?? null,
    grantedScopes: (
      body?.data?.currentAppInstallation?.accessScopes ?? []
    ).map((scope: { handle: string }) => scope.handle),
  };
}

async function main() {
  const { shopDomain, offline } = parseArguments(process.argv.slice(2));

  if (!shopDomain) {
    throw new Error(
      "Usage: npx ts-node verify-shopify-store-token.ts --shop=<shop>.myshopify.com [--offline]",
    );
  }

  const shop = shopDomain.toLowerCase();

  if (!isValidShopDomain(shop)) {
    throw new Error(`Not a valid Shopify shop domain: ${shop}`);
  }

  const store = await prisma.storeConnection.findUnique({
    where: { shopDomain: shop },
    select: {
      id: true,
      tenantId: true,
      status: true,
      scopes: true,
      encryptedAccessToken: true,
      installedAt: true,
      disconnectedAt: true,
    },
  });

  if (!store) {
    throw new Error(
      `No StoreConnection row for ${shop}. Connect it first: npx ts-node connect-shopify-store.ts --shop=${shop} --token=…`,
    );
  }

  const problems: string[] = [];

  console.log(`Store:      ${shop} (${store.id})`);
  console.log(`Tenant:     ${store.tenantId}`);
  console.log(`Status:     ${store.status}`);
  console.log(
    `Installed:  ${store.installedAt?.toISOString() ?? "n/a"}${
      store.disconnectedAt
        ? `  — disconnected ${store.disconnectedAt.toISOString()}`
        : ""
    }`,
  );

  if (store.status !== "ACTIVE") {
    problems.push(
      `connection status is ${store.status}; order webhooks are ignored until it is ACTIVE again (reconnect the store)`,
    );
  }

  if (!store.encryptedAccessToken) {
    problems.push(
      "no access token is stored, so nothing can be pulled from Shopify (this is the state after app/uninstalled)",
    );
  }

  if (problems.length === 0 || store.encryptedAccessToken) {
    const encryptionKey = process.env.ENCRYPTION_KEY;

    if (!encryptionKey) {
      problems.push("ENCRYPTION_KEY is not configured");
    } else if (store.encryptedAccessToken) {
      let accessToken: string;

      try {
        accessToken = decryptSecret(store.encryptedAccessToken, encryptionKey);
      } catch {
        throw new Error(
          "The stored token cannot be decrypted with the current ENCRYPTION_KEY. Either the key changed since the store was connected, or this is a different environment's database — reconnect the store with the right key.",
        );
      }

      console.log(
        `Token:      present, decrypts with the current ENCRYPTION_KEY`,
      );

      if (offline) {
        console.log("Shopify:    skipped (--offline)");
      } else {
        const probe = await probeShop(shop, accessToken);

        console.log(
          `Shopify:    verified${probe.name ? ` — ${probe.name}` : ""}${
            probe.grantedScopes.length
              ? ` — granted scopes: ${probe.grantedScopes.join(", ")}`
              : " — no scopes reported"
          }`,
        );

        for (const scope of EXPECTED_SCOPES) {
          if (
            probe.grantedScopes.length > 0 &&
            !probe.grantedScopes.includes(scope)
          ) {
            problems.push(
              `the token lacks "${scope}" — order sync or inventory reads will fail`,
            );
          }
        }
      }
    }
  }

  if (store.scopes?.length) {
    console.log(`Recorded:   scopes at connect time: ${store.scopes.join(", ")}`);
  }

  if (problems.length > 0) {
    console.error(`\nProblems found:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }

  console.log("\nConnection looks healthy.");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

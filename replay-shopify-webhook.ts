import "dotenv/config";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";

import { decryptSecret } from "./src/shopify/shopify-auth.crypto";
import { signShopifyWebhookPayload } from "./src/webhooks/shopify-signature";
import {
  createPrismaAdapter,
  databaseUrlFromEnv,
} from "./src/prisma/prisma-adapter";

/**
 * Sends a real, correctly signed Shopify webhook delivery to a running
 * API instance — the local half of the "no tunnel required" workflow.
 *
 * Usage:
 *   # replay a checked-in fixture
 *   npx ts-node replay-shopify-webhook.ts \
 *     --topic=orders/create --fixture=fixtures/shopify-webhooks/orders-create.json
 *
 *   # re-send a delivery that is already stored in the database
 *   npx ts-node replay-shopify-webhook.ts --from-event=<webhookEventId>
 *
 * Options:
 *   --url=http://localhost:4000        API origin (or an env deployment)
 *   --shop=<shop>.myshopify.com        defaults to SHOPIFY_SHOP_DOMAIN
 *   --event-id=<id>                    X-Shopify-Webhook-Id; defaults to a
 *                                      deterministic id derived from the
 *                                      payload so replays stay idempotent
 *   --api-version=2026-07
 *
 * Notes:
 * - The signature is computed over the exact bytes that are sent, so
 *   signature verification is exercised for real. There is no "skip HMAC"
 *   mode on purpose: that code path must match production.
 * - A 503 response means the event was stored but could not be queued
 *   (Redis unreachable). The row is queryable and can be replayed once the
 *   queue is healthy — see docs/runbooks.
 */

type ReplayOptions = {
  url: string;
  topic?: string;
  shopDomain?: string;
  fixturePath?: string;
  fromEventId?: string;
  webhookId?: string;
  apiVersion: string;
};

function parseOptions(argv: string[]): ReplayOptions {
  const values = new Map<string, string>();

  for (const argument of argv) {
    const match = argument.match(/^--([^=]+)=(.*)$/);

    if (match?.[1] !== undefined && match[2] !== undefined) {
      values.set(match[1], match[2]);
    }
  }

  return {
    url: (values.get("url") ?? "http://localhost:4000").replace(/\/+$/, ""),
    topic: values.get("topic"),
    shopDomain: values.get("shop") ?? process.env.SHOPIFY_SHOP_DOMAIN,
    fixturePath: values.get("fixture"),
    fromEventId: values.get("from-event"),
    webhookId: values.get("event-id"),
    apiVersion: values.get("api-version") ?? "2026-07",
  };
}

function usage(): never {
  throw new Error(
    [
      "Usage:",
      "  npx ts-node replay-shopify-webhook.ts --topic=<topic> --fixture=<path> [--url=...] [--shop=...] [--event-id=...]",
      "  npx ts-node replay-shopify-webhook.ts --from-event=<webhookEventId> [--url=...]",
      "",
      "Topics:",
      "  orders/create, orders/updated, orders/cancelled",
    ].join("\n"),
  );
}

/**
 * The delivery must be signed with the same secret the intake will verify:
 * the store's own secret when it has one (custom apps), otherwise the
 * deployment-wide `SHOPIFY_WEBHOOK_SECRET` (OAuth apps). Signing a fixture
 * with the environment secret for a store that has its own would be
 * rejected with 401 — correct behaviour, confusing test.
 */
async function resolveSigningSecret(
  shopDomain: string,
): Promise<{ secret: string; source: string }> {
  const environmentSecret = process.env.SHOPIFY_WEBHOOK_SECRET;

  const prisma = new PrismaClient({
    adapter: createPrismaAdapter(
      databaseUrlFromEnv(["DATABASE_URL", "APP_DATABASE_URL"]),
    ),
  });

  try {
    const store = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);

      return tx.storeConnection.findUnique({
        where: {
          platform_externalStoreId: {
            platform: "SHOPIFY",
            externalStoreId: shopDomain,
          },
        },
        select: { encryptedWebhookSecret: true },
      });
    });

    if (store?.encryptedWebhookSecret) {
      const encryptionKey = process.env.ENCRYPTION_KEY;

      if (!encryptionKey) {
        throw new Error(
          `${shopDomain} has a store-specific webhook secret but ENCRYPTION_KEY is not configured`,
        );
      }

      return {
        secret: decryptSecret(store.encryptedWebhookSecret, encryptionKey),
        source: "the store's stored webhook secret",
      };
    }
  } finally {
    await prisma.$disconnect();
  }

  if (!environmentSecret) {
    throw new Error(
      `SHOPIFY_WEBHOOK_SECRET is not configured and ${shopDomain} has no stored webhook secret`,
    );
  }

  return { secret: environmentSecret, source: "SHOPIFY_WEBHOOK_SECRET" };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));

  let rawBody: string;
  let topic = options.topic;
  let shopDomain = options.shopDomain;
  let webhookId = options.webhookId;

  if (options.fromEventId) {
    const prisma = new PrismaClient({
      adapter: createPrismaAdapter(
        databaseUrlFromEnv(["DATABASE_URL", "APP_DATABASE_URL"]),
      ),
    });

    try {
      const event = await prisma.$transaction(async (tx) => {
        // A single-purpose admin read of a cross-tenant table; the
        // schema-owner connection bypasses RLS for exactly this lookup.
        await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);

        return tx.webhookEvent.findUnique({
          where: { id: options.fromEventId },
          include: { store: { select: { externalStoreId: true } } },
        });
      });

      if (!event) {
        throw new Error(`No webhook event found with id ${options.fromEventId}`);
      }

      rawBody = JSON.stringify(event.payload, null, 2);
      topic = event.topic;
      shopDomain = event.store.externalStoreId;
      webhookId = event.externalEventId;
    } finally {
      await prisma.$disconnect();
    }
  } else {
    if (!options.fixturePath) usage();

    rawBody = readFileSync(options.fixturePath, "utf8");
  }

  if (!topic) usage();
  if (!shopDomain) {
    throw new Error(
      "Shop domain is required: pass --shop=<domain> or set SHOPIFY_SHOP_DOMAIN",
    );
  }

  // Deterministic by default: replaying the same fixture twice exercises
  // the duplicate-delivery path instead of creating a second order.
  if (!webhookId) {
    const digest = createHash("sha256")
      .update(`${topic}:${shopDomain}:${rawBody}`)
      .digest("hex")
      .slice(0, 32);

    webhookId = `replay-${digest}`;
  }

  const signing = await resolveSigningSecret(shopDomain);

  console.log(`Signing as ${signing.source} for ${shopDomain}`);

  const signature = signShopifyWebhookPayload(Buffer.from(rawBody), signing.secret);

  const response = await fetch(`${options.url}/webhooks/shopify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Hmac-Sha256": signature,
      "X-Shopify-Shop-Domain": shopDomain,
      "X-Shopify-Topic": topic,
      "X-Shopify-Webhook-Id": webhookId,
      "X-Shopify-API-Version": options.apiVersion,
    },
    body: rawBody,
  });

  const body = await response.text();

  console.log(
    JSON.stringify(
      {
        url: options.url,
        topic,
        shopDomain,
        webhookId,
        httpStatus: response.status,
        response: safeJson(body),
      },
      null,
      2,
    ),
  );

  if (!response.ok) {
    console.error(
      response.status === 503
        ? "The delivery was stored but not queued (queue unavailable). Re-run this command once Redis is reachable."
        : "Delivery rejected; see the response above.",
    );
    process.exitCode = 1;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 500);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

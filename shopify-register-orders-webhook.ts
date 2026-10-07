import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { decryptSecret } from "./src/shopify/shopify-auth.crypto";
import {
  evaluateWebhookRegistrationGuards,
  MANAGED_WEBHOOK_TOPICS,
  planWebhookSubscriptionReconciliation,
} from "./src/shopify/webhook-registration";
import {
  createPrismaAdapter,
  databaseUrlFromEnv,
} from "./src/prisma/prisma-adapter";

/**
 * Reconciles this app's Shopify webhook subscriptions with what Shopify
 * currently has registered for the store.
 *
 * Usage:
 *   npx ts-node shopify-register-orders-webhook.ts --shop=<shop>.myshopify.com \
 *     [--dry-run] [--allow-tunnel]
 *
 * Scope: this registers topics the **Admin API can create** — orders/* and
 * app/uninstalled — each gated by its own topic scope (read_orders covers the
 * three order topics; app/uninstalled needs none). Shopify's mandatory privacy
 * topics (customers/data_request, customers/redact, shop/redact) are
 * deliberately NOT registrable here: Shopify only accepts them through app
 * configuration (shopify.app.toml) or the Dev Dashboard, and admin-created
 * custom apps cannot use app configuration at all. `--include-compliance`
 * fails loudly with that explanation rather than appearing to succeed.
 *
 * Why reconciling instead of "create if missing":
 *
 * - Shopify keeps subscriptions per store, not per environment. Every
 *   re-registration with a rotating tunnel URL leaves another dead URI
 *   behind, and each one is a delivery that goes nowhere.
 * - A subscription whose URI has been unreachable for ~48h is deleted by
 *   Shopify, so "we stopped receiving orders" is a silent failure mode.
 *
 * The script therefore creates what is missing, moves the URIs that are
 * ours (same host, another environment on APP_DOMAIN, or a leftover
 * tunnel) to the current `APP_URL`, and removes our duplicate
 * registrations — while never touching a subscription that belongs to a
 * different integration.
 */

const GRAPHQL_VERSION = "2026-07";

const CREATE_SUBSCRIPTION = `
  mutation webhookSubscriptionCreate(
    $topic: WebhookSubscriptionTopic!
    $webhookSubscription: WebhookSubscriptionInput!
  ) {
    webhookSubscriptionCreate(
      topic: $topic
      webhookSubscription: $webhookSubscription
    ) {
      webhookSubscription { id topic uri }
      userErrors { field message }
    }
  }
`;

const UPDATE_SUBSCRIPTION = `
  mutation webhookSubscriptionUpdate(
    $id: ID!
    $webhookSubscription: WebhookSubscriptionInput!
  ) {
    webhookSubscriptionUpdate(
      id: $id
      webhookSubscription: $webhookSubscription
    ) {
      webhookSubscription { id topic uri }
      userErrors { field message }
    }
  }
`;

const DELETE_SUBSCRIPTION = `
  mutation webhookSubscriptionDelete($id: ID!) {
    webhookSubscriptionDelete(id: $id) {
      deletedWebhookSubscriptionId
      userErrors { field message }
    }
  }
`;

type ShopifySubscription = { id: string; topic: string; uri: string };

type GraphqlFailure = { userErrors?: Array<{ field: string[]; message: string }> };

function parseArguments(argv: string[]) {
  const flags = new Set(
    argv.filter((argument) => argument.startsWith("--") && !argument.includes("=")),
  );

  const values = new Map<string, string>();

  for (const argument of argv) {
    const match = argument.match(/^--([^=]+)=(.*)$/);

    if (match?.[1] !== undefined && match[2] !== undefined) {
      values.set(match[1], match[2]);
    }
  }

  return {
    shopDomain: values.get("shop")?.trim(),
    dryRun: flags.has("--dry-run"),
    allowTunnel: flags.has("--allow-tunnel"),
    includeCompliance: flags.has("--include-compliance"),
  };
}

const prisma = new PrismaClient({
  adapter: createPrismaAdapter(
    databaseUrlFromEnv(["DATABASE_URL", "APP_DATABASE_URL"]),
  ),
});

async function shopifyGraphql(
  shopDomain: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; body: any }> {
  let response: Response;

  try {
    response = await fetch(
      `https://${shopDomain}/admin/api/${GRAPHQL_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query, variables }),
      },
    );
  } catch (error) {
    // A bare "fetch failed" from here is almost always one of: no outbound
    // network from where the script runs (CI, a locked-down box, this
    // sandbox), a corporate proxy, or a typo'd shop domain — none of which
    // the operator can tell apart from the raw Node error.
    throw new Error(
      `Could not reach https://${shopDomain}/admin/api/${GRAPHQL_VERSION}/graphql.json (${
        error instanceof Error ? error.message : String(error)
      }). Check that the shop domain is right and that this machine can reach Shopify's Admin API — a sandbox or CI runner with restricted egress will fail here even though the store and token are fine.`,
    );
  }

  const body = await response.json().catch(() => ({}));

  return { ok: response.ok, status: response.status, body };
}

function userErrorsOf(body: any): Array<{ field: string[]; message: string }> {
  const payload = body?.data ?? {};

  for (const value of Object.values(payload) as GraphqlFailure[]) {
    if (value?.userErrors?.length) {
      return value.userErrors;
    }
  }

  return [];
}

async function main() {
  const { shopDomain, dryRun, allowTunnel, includeCompliance } =
    parseArguments(process.argv.slice(2));

  if (includeCompliance) {
    // Not an unimplemented feature — an impossible one through this API.
    throw new Error(
      [
        "Compliance webhooks cannot be registered through the Admin API.",
        "",
        "customers/data_request, customers/redact and shop/redact are configured",
        "in app configuration (shopify.app.toml / Dev Dashboard) and are only",
        "available to apps Shopify manages that way. An admin-created custom app",
        "cannot subscribe to them at all, so it will not receive privacy requests",
        "from Shopify.",
        "",
        "What to do instead:",
        "  - Route A (OAuth app): set the three privacy URLs in the Partner",
        "    Dashboard app settings (see docs/SHOPIFY-CONNECT.md).",
        "  - Route B (custom app): handle data requests out of band. The API still",
        "    answers these topics correctly if one is ever delivered (audit event +",
        "    HIGH COMPLIANCE exception), but Shopify will not send them.",
      ].join("\n"),
    );
  }
  const appUrl = process.env.APP_URL?.replace(/\/+$/, "");
  const appDomain = process.env.APP_DOMAIN?.trim() || undefined;
  const nodeEnv = process.env.NODE_ENV ?? "development";
  const encryptionKey = process.env.ENCRYPTION_KEY;

  if (!appUrl) throw new Error("APP_URL is not configured");
  if (!encryptionKey) throw new Error("ENCRYPTION_KEY is not configured");

  if (!shopDomain) {
    throw new Error(
      "Usage: npx ts-node shopify-register-orders-webhook.ts --shop=<shop>.myshopify.com [--dry-run] [--allow-tunnel]",
    );
  }

  const webhookUri = `${appUrl}/webhooks/shopify`;

  const problems = evaluateWebhookRegistrationGuards({
    appUrl,
    nodeEnv,
    appDomain,
    shopDomain,
    allowTunnel,
  });

  if (problems.length > 0) {
    throw new Error(
      [
        "Refusing to register webhooks:",
        ...problems.map((problem) => `  - ${problem}`),
        "Production rules (https, deployed host, inside APP_DOMAIN) are not overridable.",
      ].join("\n"),
    );
  }

  const store = await prisma.storeConnection.findUnique({
    where: { shopDomain },
    select: {
      shopDomain: true,
      status: true,
      encryptedAccessToken: true,
      scopes: true,
    },
  });

  if (!store) throw new Error(`Store not found: ${shopDomain}`);
  if (!store.encryptedAccessToken) {
    throw new Error("Encrypted Shopify access token is missing");
  }

  const accessToken = decryptSecret(store.encryptedAccessToken, encryptionKey);

  const existing = await shopifyGraphql(
    shopDomain,
    accessToken,
    `query { webhookSubscriptions(first: 100) { nodes { id topic uri } } }`,
    {},
  );

  if (!existing.ok) {
    throw new Error(
      `Could not read existing subscriptions (HTTP ${existing.status})`,
    );
  }

  const subscriptions: ShopifySubscription[] =
    existing.body?.data?.webhookSubscriptions?.nodes ?? [];

  const plan = planWebhookSubscriptionReconciliation({
    existing: subscriptions,
    desiredUri: webhookUri,
    ownedDomain: appDomain,
  });

  const summary = {
    shopDomain,
    environment: nodeEnv,
    webhookUri,
    dryRun,
    plan,
  };

  if (dryRun) {
    console.log(JSON.stringify({ ...summary, actions: [] }, null, 2));
    return;
  }

  const actions: Array<Record<string, unknown>> = [];

  for (const topic of plan.create) {
    const response = await shopifyGraphql(
      shopDomain,
      accessToken,
      CREATE_SUBSCRIPTION,
      { topic, webhookSubscription: { uri: webhookUri } },
    );

    const userErrors = userErrorsOf(response.body);

    actions.push({
      action: "create",
      topic,
      ok: response.ok && userErrors.length === 0,
      httpStatus: response.status,
      userErrors,
    });
  }

  for (const entry of plan.update) {
    const response = await shopifyGraphql(
      shopDomain,
      accessToken,
      UPDATE_SUBSCRIPTION,
      { id: entry.id, webhookSubscription: { uri: entry.toUri } },
    );

    const userErrors = userErrorsOf(response.body);

    actions.push({
      action: "update",
      topic: entry.topic,
      from: entry.fromUri,
      to: entry.toUri,
      ok: response.ok && userErrors.length === 0,
      httpStatus: response.status,
      userErrors,
    });
  }

  for (const entry of plan.delete) {
    const response = await shopifyGraphql(
      shopDomain,
      accessToken,
      DELETE_SUBSCRIPTION,
      { id: entry.id },
    );

    const userErrors = userErrorsOf(response.body);

    actions.push({
      action: "delete",
      topic: entry.topic,
      uri: entry.uri,
      ok: response.ok && userErrors.length === 0,
      httpStatus: response.status,
      userErrors,
    });
  }

  console.log(JSON.stringify({ ...summary, actions }, null, 2));

  const failed = actions.filter((action) => action.ok === false);

  if (failed.length > 0) {
    console.error(
      `${failed.length} webhook subscription action(s) failed; the store may not deliver every topic.`,
    );
    process.exitCode = 1;
  }

  if (plan.unmanaged.length > 0) {
    console.error(
      `Left ${plan.unmanaged.length} subscription(s) for ${MANAGED_WEBHOOK_TOPICS.join(", ")} alone because they belong to another integration: ${plan.unmanaged
        .map((entry) => `${entry.topic} -> ${entry.uri}`)
        .join("; ")}`,
    );
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

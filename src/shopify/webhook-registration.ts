/**
 * Pure helpers behind the webhook registration tooling.
 *
 * They live in `src/` (rather than inside the admin script) so the rules
 * about which origins are safe to register with Shopify are unit-tested
 * and reusable: the same tunnel detection protects `APP_URL` validation
 * in `src/config/environment.ts`.
 *
 * Why this matters: a Shopify webhook subscription is stored on Shopify's
 * side, keyed by URI, and shared by every environment that installs the
 * app on that store. Registering a rotating tunnel URL (a) sends
 * production traffic to a laptop, and (b) when the tunnel dies, Shopify
 * retries for ~48h and then deletes the subscription — so the failure
 * mode is "we quietly stopped receiving orders".
 */

export const MANAGED_WEBHOOK_TOPICS = [
  "ORDERS_CREATE",
  "ORDERS_UPDATED",
  "ORDERS_CANCELLED",
  // Store lifecycle: when a merchant uninstalls, we must stop treating the
  // connection as live (the stored access token dies with the install).
  "APP_UNINSTALLED",
] as const;

export type ManagedWebhookTopic = (typeof MANAGED_WEBHOOK_TOPICS)[number];

export type ComplianceWebhookTopic =
  | "CUSTOMERS_DATA_REQUEST"
  | "CUSTOMERS_REDACT"
  | "SHOP_REDACT";

/** The topic string Shopify puts in `X-Shopify-Topic` for a delivery. */
export type ComplianceRestTopic =
  | "customers/data_request"
  | "customers/redact"
  | "shop/redact";

/**
 * Shopify's mandatory privacy topics. These are the ones the *processor*
 * must recognize; they cannot be registered through the Admin API at all —
 * Shopify accepts them only via app configuration (shopify.app.toml) or the
 * Dev Dashboard, and admin-created custom apps cannot use app configuration.
 * They are listed here so the delimiters (GraphQL name vs the topic string
 * that arrives in `X-Shopify-Topic`) stay in one place; see
 * `isComplianceRestTopic` and the processor's compliance handling.
 *
 * The two names are listed together on purpose: the Admin API's GraphQL
 * topic name and the topic string that arrives on the webhook are only
 * *usually* the same shape (`SHOP_REDACT` → `shop/redact`) — the data
 * request keeps its underscore (`customers/data_request`). Converting the
 * GraphQL name mechanically produces `customers/data/request`, which
 * matches no delivery, so such a request would fall through to the
 * "unsupported topic" branch and be dropped instead of escalated.
 */
export const COMPLIANCE_WEBHOOK_SUBSCRIPTIONS: ReadonlyArray<{
  topic: ComplianceWebhookTopic;
  restTopic: ComplianceRestTopic;
}> = [
  { topic: "CUSTOMERS_DATA_REQUEST", restTopic: "customers/data_request" },
  { topic: "CUSTOMERS_REDACT", restTopic: "customers/redact" },
  { topic: "SHOP_REDACT", restTopic: "shop/redact" },
];

export const COMPLIANCE_WEBHOOK_TOPICS: readonly ComplianceWebhookTopic[] =
  COMPLIANCE_WEBHOOK_SUBSCRIPTIONS.map((subscription) => subscription.topic);

/** `X-Shopify-Topic` values handled by `handleComplianceRequest`. */
export const COMPLIANCE_REST_TOPICS: readonly ComplianceRestTopic[] =
  COMPLIANCE_WEBHOOK_SUBSCRIPTIONS.map(
    (subscription) => subscription.restTopic,
  );

const COMPLIANCE_REST_TOPIC_SET = new Set<string>(COMPLIANCE_REST_TOPICS);

/** True for deliveries that must be answered inside Shopify's 30-day window. */
export function isComplianceRestTopic(topic: string): boolean {
  return COMPLIANCE_REST_TOPIC_SET.has(topic);
}

/**
 * Hosts that only ever serve traffic while a developer's process is
 * running. None of these belong in `APP_URL` for a shared environment.
 */
const TUNNEL_HOST_SUFFIXES = [
  "ngrok.io",
  "ngrok.app",
  "ngrok-free.app",
  "ngrok-free.dev",
  "trycloudflare.com",
  "cfargotunnel.com",
  "loca.lt",
  "localtunnel.me",
  "serveo.net",
  "lhr.life",
  "localhost.run",
  "telebit.io",
  "translate.goog",
  "tunnel.dev",
] as const;

export function normalizeHostname(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "").replace(/^\./, "");
}

/** Throws for anything that is not an absolute URL. */
export function hostnameFromUrl(url: string): string {
  try {
    return normalizeHostname(new URL(url).hostname);
  } catch {
    throw new Error(`Not a valid absolute URL: ${url}`);
  }
}

export function isTunnelHostname(host: string): boolean {
  const normalized = normalizeHostname(host);

  return TUNNEL_HOST_SUFFIXES.some(
    (suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`),
  );
}

export function isLocalHostname(host: string): boolean {
  const normalized = normalizeHostname(host);

  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "[::1]" ||
    normalized === "::1" ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".localhost") ||
    /^(10|127)\./.test(normalized) ||
    /^192\.168\./.test(normalized) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(normalized)
  );
}

/**
 * True when `host` is `domain` or a subdomain of it. `reygent.com` accepts
 * `api.reygent.com`; it rejects `reygent.com.evil.test` and `other.com`.
 */
export function isHostWithinDomain(host: string, domain: string): boolean {
  const normalizedHost = normalizeHostname(host);
  const normalizedDomain = normalizeHostname(domain);

  if (normalizedDomain.length === 0) {
    return false;
  }

  return (
    normalizedHost === normalizedDomain ||
    normalizedHost.endsWith(`.${normalizedDomain}`)
  );
}

/* ------------------------------------------------------------------ */
/* Reconciliation                                                      */
/* ------------------------------------------------------------------ */

export type ExistingWebhookSubscription = {
  id: string;
  topic: string;
  uri: string;
};

export type SubscriptionToUpdate = {
  id: string;
  topic: string;
  fromUri: string;
  toUri: string;
};

export type SubscriptionToDelete = {
  id: string;
  topic: string;
  uri: string;
};

export type WebhookReconciliationPlan = {
  create: ManagedWebhookTopic[];
  update: SubscriptionToUpdate[];
  delete: SubscriptionToDelete[];
  unchanged: Array<{ id: string; topic: string; uri: string }>;
  /**
   * Subscriptions for our topics that point at a host we do not own
   * (another app, a partner integration, a hand-made subscription).
   * Reported, never modified — deleting someone else's webhook would
   * silently break their integration.
   */
  unmanaged: Array<{ id: string; topic: string; uri: string }>;
};

function isStaleOurs(
  uri: string,
  desiredHost: string,
  ownedDomain?: string,
): boolean {
  let host: string;

  try {
    host = hostnameFromUrl(uri);
  } catch {
    // An unparseable URI on our topic can't be ours to reason about.
    return false;
  }

  if (host === desiredHost) return true;
  if (isTunnelHostname(host)) return true;

  // Another environment's origin for the same app (e.g. the store was
  // pointed at staging-api.reygent.com and is being moved to api.…).
  return Boolean(ownedDomain && isHostWithinDomain(host, ownedDomain));
}

/**
 * Diffs the subscriptions Shopify currently has against the ones we want.
 *
 * - missing topic → create
 * - same topic, different URI, host that is ours (current host or a stale
 *   tunnel host) → update in place
 * - same topic, someone else's host → leave alone, report
 * - topics we do not manage → report only
 */
export function planWebhookSubscriptionReconciliation(input: {
  existing: ExistingWebhookSubscription[];
  desiredUri: string;
  /** e.g. `reygent.com` — other hosts of ours that may be moved over. */
  ownedDomain?: string;
  topics?: readonly ManagedWebhookTopic[];
}): WebhookReconciliationPlan {
  const topics = input.topics ?? MANAGED_WEBHOOK_TOPICS;
  const desiredHost = hostnameFromUrl(input.desiredUri);
  const managed = new Set<string>(topics);

  const plan: WebhookReconciliationPlan = {
    create: [],
    update: [],
    delete: [],
    unchanged: [],
    unmanaged: [],
  };

  for (const topic of topics) {
    const candidates = input.existing.filter(
      (subscription) => subscription.topic === topic,
    );

    // The subscription we want, if it already exists.
    const matching = candidates.find(
      (subscription) => subscription.uri === input.desiredUri,
    );

    if (matching) {
      plan.unchanged.push({
        id: matching.id,
        topic: matching.topic,
        uri: matching.uri,
      });
    } else {
      const stale = candidates.find((subscription) =>
        isStaleOurs(subscription.uri, desiredHost, input.ownedDomain),
      );

      if (stale) {
        plan.update.push({
          id: stale.id,
          topic,
          fromUri: stale.uri,
          toUri: input.desiredUri,
        });
      } else {
        plan.create.push(topic);
      }
    }

    for (const candidate of candidates) {
      if (candidate.uri === input.desiredUri) continue;
      if (plan.update.some((entry) => entry.id === candidate.id)) continue;

      plan.unmanaged.push({
        id: candidate.id,
        topic: candidate.topic,
        uri: candidate.uri,
      });
    }
  }

  // Duplicates of our own desired URI (Shopify allows several
  // subscriptions per topic): keep one, remove the extras.
  const seenDesired = new Set<string>();
  for (const subscription of input.existing) {
    if (!managed.has(subscription.topic)) {
      plan.unmanaged.push({
        id: subscription.id,
        topic: subscription.topic,
        uri: subscription.uri,
      });
      continue;
    }

    if (subscription.uri !== input.desiredUri) continue;

    if (seenDesired.has(subscription.topic)) {
      plan.delete.push({
        id: subscription.id,
        topic: subscription.topic,
        uri: subscription.uri,
      });
      // It was reported as unchanged before we knew it was a duplicate.
      plan.unchanged = plan.unchanged.filter(
        (entry) => entry.id !== subscription.id,
      );
      continue;
    }

    seenDesired.add(subscription.topic);
  }

  return plan;
}

/* ------------------------------------------------------------------ */
/* Guards                                                              */
/* ------------------------------------------------------------------ */

export type RegistrationGuardInput = {
  appUrl: string;
  nodeEnv: string;
  /** e.g. `reygent.com`; when set, APP_URL must live under it. */
  appDomain?: string;
  shopDomain: string;
  /** Explicit dev opt-in for a tunnel URL (never valid in production). */
  allowTunnel?: boolean;
};

/**
 * Returns the reasons registration must not proceed. Empty array = safe.
 *
 * Production rules (https, no tunnel, no local host, inside APP_DOMAIN)
 * are hard: they are not overridable by a CLI flag, because the blast
 * radius is the merchant's live order feed.
 */
export function evaluateWebhookRegistrationGuards(
  input: RegistrationGuardInput,
): string[] {
  const problems: string[] = [];
  const isProduction = input.nodeEnv === "production";

  let host: string;
  let protocol: string;

  try {
    const parsed = new URL(input.appUrl);
    host = normalizeHostname(parsed.hostname);
    protocol = parsed.protocol;
  } catch {
    return [`APP_URL is not a valid absolute URL: ${input.appUrl}`];
  }

  if (isProduction) {
    if (protocol !== "https:") {
      problems.push("APP_URL must use https in production");
    }
    if (isTunnelHostname(host)) {
      problems.push(
        `APP_URL host ${host} is a tunnel host; production webhooks must point at a deployed origin`,
      );
    }
    if (isLocalHostname(host)) {
      problems.push(`APP_URL host ${host} is local; production must be public`);
    }
  } else if (isTunnelHostname(host) && !input.allowTunnel) {
    problems.push(
      `APP_URL host ${host} is a tunnel; pass --allow-tunnel for development (the webhook URI will change whenever the tunnel restarts)`,
    );
  }

  const appDomain = input.appDomain;

  if (appDomain && appDomain.trim().length > 0) {
    if (!isHostWithinDomain(host, appDomain)) {
      problems.push(
        `APP_URL host ${host} is not inside APP_DOMAIN ${appDomain}`,
      );
    }
  } else if (isProduction) {
    problems.push("APP_DOMAIN must be configured in production");
  }

  if (!/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/.test(input.shopDomain)) {
    problems.push(`Shop domain does not look valid: ${input.shopDomain}`);
  }

  return problems;
}

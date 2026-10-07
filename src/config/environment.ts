import { z } from "zod";

import {
  hostnameFromUrl,
  isHostWithinDomain,
  isLocalHostname,
  isTunnelHostname,
} from "../shopify/webhook-registration";

const optionalStringFromBlank = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().min(1).optional(),
);

const optionalUrlFromBlank = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().url().optional(),
);

const redisUrl = z
  .string()
  .url()
  .refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === "redis:" || protocol === "rediss:";
    } catch {
      return false;
    }
  }, "REDIS_URL must use redis:// or rediss://");

const schema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),

    PORT: z
      .coerce
      .number()
      .int()
      .min(1)
      .max(65535)
      .default(4000),

    DATABASE_URL: z.string().url(),

    /**
     * The application's runtime connection. Use the restricted,
     * non-superuser role so PostgreSQL row-level security is active.
     * An empty value in a local .env is treated as unset for backwards
     * compatibility; the checked-in example provides the app-role URL.
     */
    APP_DATABASE_URL: optionalUrlFromBlank,

    REDIS_URL: redisUrl,

    /**
     * Deadline for handing a stored webhook to the queue. Shopify drops
     * deliveries that take longer than 5 seconds to acknowledge, so a
     * slow/unreachable Redis must fail fast (503) rather than hold the
     * request open.
     */
    WEBHOOK_ENQUEUE_TIMEOUT_MS: z
      .coerce
      .number()
      .int()
      .min(250)
      .max(30_000)
      .default(4000),

    JWT_SECRET: z.string().min(32),

    ENCRYPTION_KEY: z.string().min(32),

    /**
     * The externally reachable API origin. Shopify registers its
     * webhook subscriptions against this value, so it must be a real,
     * stable origin in shared environments — production additionally
     * requires https and a host inside APP_DOMAIN (see superRefine).
     */
    APP_URL: z.string().url(),

    /**
     * Registrable domain this deployment lives under, e.g. `reygent.com`
     * for `api.reygent.com` / `staging-api.reygent.com`. Required in
     * production; enforced against APP_URL whenever it is set.
     */
    APP_DOMAIN: optionalStringFromBlank,

    // Integration credentials are optional for local development so
    // the API, health endpoint, and unit tests can run without access
    // to a real Shopify app or LLM provider. The affected feature gives
    // a clear configuration error when it is used without credentials.
    SHOPIFY_API_KEY: optionalStringFromBlank,

    SHOPIFY_API_SECRET: optionalStringFromBlank,

    SHOPIFY_SCOPES: z
      .string()
      .min(1)
      .default("read_orders,read_products,read_inventory"),

    SHOPIFY_WEBHOOK_SECRET: optionalStringFromBlank,

    SHOPIFY_WRITE_SCOPES: z
      .string()
      .min(1)
      .default("write_orders"),

    GROQ_API_KEY: optionalStringFromBlank,

    GROQ_MODEL: z
      .string()
      .min(1)
      .default("openai/gpt-oss-120b"),

    AI_INVESTIGATION_MAX_TOOL_CALLS: z
      .coerce
      .number()
      .int()
      .min(1)
      .default(8),

    AI_INVESTIGATION_TIMEOUT_MS: z
      .coerce
      .number()
      .int()
      .min(1000)
      .default(60000),

    AI_INVESTIGATION_MAX_TOKENS: z
      .coerce
      .number()
      .int()
      .min(1000)
      .default(20000),
  })
  .superRefine((values, context) => {
    const appDomain = values.APP_DOMAIN;
    const isProduction = values.NODE_ENV === "production";

    if (isProduction && !appDomain) {
      context.addIssue({
        code: "custom",
        path: ["APP_DOMAIN"],
        message: "APP_DOMAIN must be configured in production",
      });
    }

    let appUrlHost: string | undefined;

    try {
      appUrlHost = hostnameFromUrl(values.APP_URL);
    } catch {
      appUrlHost = undefined;
    }

    if (appDomain) {
      if (appUrlHost && !isHostWithinDomain(appUrlHost, appDomain)) {
        context.addIssue({
          code: "custom",
          path: ["APP_URL"],
          message: `APP_URL must live under APP_DOMAIN ${appDomain}`,
        });
      }
    } else if (appUrlHost && !isLocalHostname(appUrlHost)) {
      // A public origin without APP_DOMAIN is a half-configured deployment:
      // nothing then stops APP_URL from being someone else's domain, and the
      // registration script cannot tell this app's subscriptions apart from
      // another integration's — so it would happily add a second
      // subscription for a topic that already has one, and the store would
      // deliver every event twice.
      context.addIssue({
        code: "custom",
        path: ["APP_DOMAIN"],
        message: `APP_DOMAIN must be configured (the registrable domain of ${appUrlHost}) whenever APP_URL is a public origin`,
      });
    }

    if (isProduction) {
      let parsed: URL | undefined;

      try {
        parsed = new URL(values.APP_URL);
      } catch {
        parsed = undefined;
      }

      if (parsed) {
        if (parsed.protocol !== "https:") {
          context.addIssue({
            code: "custom",
            path: ["APP_URL"],
            message: "APP_URL must use https in production",
          });
        }

        if (isTunnelHostname(parsed.hostname)) {
          context.addIssue({
            code: "custom",
            path: ["APP_URL"],
            message:
              "APP_URL must not be a tunnel host in production; Shopify webhook subscriptions would break when the tunnel stops",
          });
        }

        if (isLocalHostname(parsed.hostname)) {
          context.addIssue({
            code: "custom",
            path: ["APP_URL"],
            message: "APP_URL must be publicly reachable in production",
          });
        }
      }
    }

    if (!isProduction) {
      return;
    }

    const productionRequired: Array<keyof typeof values> = [
      "APP_DATABASE_URL",
      "SHOPIFY_API_KEY",
      "SHOPIFY_API_SECRET",
      "SHOPIFY_WEBHOOK_SECRET",
      "GROQ_API_KEY",
    ];

    for (const key of productionRequired) {
      if (!values[key]) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: `${key} must be configured in production`,
        });
      }
    }
  });

export type Environment = z.infer<typeof schema>;

export function validateEnvironment(
  values: Record<string, unknown>,
): Environment {
  return schema.parse(values);
}

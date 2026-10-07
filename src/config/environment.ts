import { z } from "zod";

const schema = z.object({
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
   * The application's actual runtime connection, as a non-superuser,
   * non-BYPASSRLS role — required for RLS to mean anything. Postgres
   * unconditionally exempts superusers from row-level security no
   * matter how policies are configured, so DATABASE_URL (used for
   * migrations, which need real DDL/ownership privileges) must never
   * be the connection the running app itself queries through.
   * Falls back to DATABASE_URL if unset, for environments that
   * haven't provisioned the restricted role yet — RLS simply won't
   * do anything in that case, same as before this existed.
   */
  APP_DATABASE_URL: z.string().url().optional(),

  REDIS_URL: z.string().url(),

  JWT_SECRET: z.string().min(32),

  ENCRYPTION_KEY: z.string().min(32),

  APP_URL: z.string().url(),

  SHOPIFY_API_KEY: z.string().min(1),

  SHOPIFY_API_SECRET: z.string().min(1),

  SHOPIFY_SCOPES: z
    .string()
    .min(1)
    .default(
      "read_orders,read_products,read_inventory",
    ),

  SHOPIFY_WEBHOOK_SECRET: z.string().min(1),

  /**
   * Requested only through the separate write-access re-consent flow
   * (GET /auth/shopify/request-write-access), never bundled into the
   * initial read-only install. A merchant who never grants these
   * scopes simply never has any AI proposal executable that needs
   * them — ShopifyActionAdapter refuses to write without them.
   */
  SHOPIFY_WRITE_SCOPES: z
    .string()
    .min(1)
    .default("write_orders"),

  GROQ_API_KEY: z.string().min(1),

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
});

export type Environment = z.infer<typeof schema>;

export function validateEnvironment(
  values: Record<string, unknown>,
): Environment {
  return schema.parse(values);
}

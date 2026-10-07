import type { RedisOptions } from "ioredis";

/**
 * Convert the single REDIS_URL setting into the connection options used
 * by BullMQ/ioredis. Parsing it here prevents the API from validating
 * REDIS_URL while silently connecting to localhost via stale host/port
 * settings.
 */
export function parseRedisConnectionOptions(redisUrl: string): RedisOptions {
  let parsed: URL;

  try {
    parsed = new URL(redisUrl);
  } catch {
    throw new Error("REDIS_URL must be a valid URL");
  }

  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
    throw new Error("REDIS_URL must use redis:// or rediss://");
  }

  if (!parsed.hostname) {
    throw new Error("REDIS_URL must include a hostname");
  }

  const databasePath = parsed.pathname.replace(/^\//, "");

  if (databasePath && !/^\d+$/.test(databasePath)) {
    throw new Error("REDIS_URL path must be a numeric database index");
  }

  const options: RedisOptions = {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    maxRetriesPerRequest: null,
  };

  if (parsed.username) {
    options.username = decodeURIComponent(parsed.username);
  }

  if (parsed.password) {
    options.password = decodeURIComponent(parsed.password);
  }

  if (databasePath) {
    options.db = Number(databasePath);
  }

  if (parsed.protocol === "rediss:") {
    options.tls = {};
  }

  return options;
}

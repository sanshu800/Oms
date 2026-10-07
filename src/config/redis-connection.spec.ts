import { describe, expect, it } from "vitest";

import { parseRedisConnectionOptions } from "./redis-connection";

describe("parseRedisConnectionOptions", () => {
  it("parses a local Redis URL and sets BullMQ's required retry option", () => {
    expect(parseRedisConnectionOptions("redis://localhost:6379")).toMatchObject({
      host: "localhost",
      port: 6379,
      maxRetriesPerRequest: null,
    });
  });

  it("parses credentials and the selected Redis database", () => {
    expect(
      parseRedisConnectionOptions("redis://worker:p%40ss@cache.example:6381/4"),
    ).toMatchObject({
      host: "cache.example",
      port: 6381,
      username: "worker",
      password: "p@ss",
      db: 4,
    });
  });

  it("enables TLS for rediss URLs", () => {
    expect(parseRedisConnectionOptions("rediss://cache.example")).toMatchObject({
      host: "cache.example",
      port: 6379,
      tls: {},
    });
  });

  it("rejects invalid schemes and database paths", () => {
    expect(() =>
      parseRedisConnectionOptions("http://cache.example:6379"),
    ).toThrow("REDIS_URL must use redis:// or rediss://");

    expect(() =>
      parseRedisConnectionOptions("redis://cache.example/not-a-database"),
    ).toThrow("REDIS_URL path must be a numeric database index");
  });
});

import { describe, expect, it } from "vitest";

import { validateEnvironment } from "./environment";

function validDevelopmentEnvironment(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    NODE_ENV: "development",
    DATABASE_URL:
      "postgresql://techmart:techmart_dev_password@localhost:5432/techmart?schema=public",
    APP_DATABASE_URL:
      "postgresql://techmart_app:techmart_app_dev_password@localhost:5432/techmart?schema=public",
    REDIS_URL: "redis://localhost:6379",
    JWT_SECRET: "local-development-jwt-secret-that-is-long-enough",
    ENCRYPTION_KEY: "local-development-encryption-key-long-enough",
    APP_URL: "http://localhost:4000",
    SHOPIFY_API_KEY: "",
    SHOPIFY_API_SECRET: "",
    SHOPIFY_WEBHOOK_SECRET: "",
    GROQ_API_KEY: "",
    ...overrides,
  };
}

describe("validateEnvironment", () => {
  it("accepts the local example without third-party credentials", () => {
    const environment = validateEnvironment(validDevelopmentEnvironment());

    expect(environment.NODE_ENV).toBe("development");
    expect(environment.APP_DATABASE_URL).toContain("techmart_app");
    expect(environment.SHOPIFY_API_KEY).toBeUndefined();
    expect(environment.SHOPIFY_API_SECRET).toBeUndefined();
    expect(environment.SHOPIFY_WEBHOOK_SECRET).toBeUndefined();
    expect(environment.GROQ_API_KEY).toBeUndefined();
  });

  it("treats an empty optional app database URL as unset", () => {
    const environment = validateEnvironment(
      validDevelopmentEnvironment({ APP_DATABASE_URL: "" }),
    );

    expect(environment.APP_DATABASE_URL).toBeUndefined();
  });

  it("requires APP_URL", () => {
    expect(() =>
      validateEnvironment(
        validDevelopmentEnvironment({ APP_URL: undefined }),
      ),
    ).toThrow();
  });

  it("rejects non-Redis URLs", () => {
    expect(() =>
      validateEnvironment(
        validDevelopmentEnvironment({ REDIS_URL: "http://localhost:6379" }),
      ),
    ).toThrow("REDIS_URL must use redis:// or rediss://");
  });

  it("requires the restricted runtime URL and integration keys in production", () => {
    expect(() =>
      validateEnvironment(
        validDevelopmentEnvironment({
          NODE_ENV: "production",
          APP_DATABASE_URL: "",
        }),
      ),
    ).toThrow();

    expect(() =>
      validateEnvironment(
        validDevelopmentEnvironment({
          NODE_ENV: "production",
          APP_DATABASE_URL:
            "postgresql://techmart_app:secret@db.example.com:5432/techmart",
        }),
      ),
    ).toThrow();
  });
  describe("APP_URL and APP_DOMAIN together", () => {
    it("accepts the development host on the agency domain", () => {
      const environment = validateEnvironment(
        validDevelopmentEnvironment({
          APP_URL: "https://oms.reygent.com",
          APP_DOMAIN: "reygent.com",
        }),
      );

      expect(environment.APP_URL).toBe("https://oms.reygent.com");
      expect(environment.APP_DOMAIN).toBe("reygent.com");
    });

    it("accepts a plain local origin with no APP_DOMAIN", () => {
      expect(() =>
        validateEnvironment(validDevelopmentEnvironment()),
      ).not.toThrow();
    });

    // A public origin without APP_DOMAIN cannot be checked against anything:
    // the registration script would then treat another environment's
    // subscription as a stranger's and register a second one for the same
    // topic, so the store delivers every order twice.
    it("rejects a public origin with no APP_DOMAIN", () => {
      expect(() =>
        validateEnvironment(
          validDevelopmentEnvironment({ APP_URL: "https://oms.reygent.com" }),
        ),
      ).toThrow(/APP_DOMAIN must be configured/);
    });

    it("rejects an origin outside the configured domain", () => {
      expect(() =>
        validateEnvironment(
          validDevelopmentEnvironment({
            APP_URL: "https://oms.other-agency.com",
            APP_DOMAIN: "reygent.com",
          }),
        ),
      ).toThrow(/APP_URL must live under APP_DOMAIN reygent.com/);
    });

    it("still rejects tunnels, plain http and localhost in production", () => {
      const production = {
        NODE_ENV: "production",
        APP_DATABASE_URL:
          "postgresql://techmart_app:secret@db.example.com:5432/techmart",
        SHOPIFY_API_KEY: "key",
        SHOPIFY_API_SECRET: "secret",
        SHOPIFY_WEBHOOK_SECRET: "webhook-secret",
        GROQ_API_KEY: "groq",
        APP_DOMAIN: "reygent.com",
      };

      for (const appUrl of [
        "https://abc123.ngrok-free.app",
        "http://api.reygent.com",
        "https://localhost:4000",
      ]) {
        expect(() =>
          validateEnvironment(
            validDevelopmentEnvironment({ ...production, APP_URL: appUrl }),
          ),
        ).toThrow();
      }
    });
  });
});

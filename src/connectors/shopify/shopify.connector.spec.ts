import { describe, expect, it, vi } from "vitest";

vi.mock("@prisma/client", () => import("../../../test-utils/prisma-client.mock"));

import { UnauthorizedException } from "@nestjs/common";

import { encryptSecret } from "../../shopify/shopify-auth.crypto";
import { signShopifyWebhookPayload } from "../../webhooks/shopify-signature";
import { ShopifyConnector } from "./shopify.connector";

const TEST_ENCRYPTION_KEY = "test-encryption-key-for-webhook-secrets";

function makeConnector(configValues: Record<string, unknown> = {}) {
  const config = {
    get: vi.fn((key: string) => configValues[key]),
  };
  return new ShopifyConnector({} as never, config as never);
}

const RAW_BODY = Buffer.from(JSON.stringify({ id: 1 }), "utf8");

function headers(overrides: Record<string, string | undefined> = {}) {
  return {
    "x-shopify-hmac-sha256": signShopifyWebhookPayload(RAW_BODY, "secret"),
    "x-shopify-shop-domain": "techmart-lab.myshopify.com",
    "x-shopify-webhook-id": "wh-1",
    "x-shopify-topic": "orders/create",
    ...overrides,
  };
}

describe("ShopifyConnector.readEnvelope", () => {
  it("extracts the delivery identity from Shopify headers", () => {
    const connector = makeConnector();

    expect(connector.readEnvelope(headers())).toEqual({
      storeKey: "techmart-lab.myshopify.com",
      externalEventId: "wh-1",
      topic: "orders/create",
    });
  });

  it("rejects missing headers with the exact error", () => {
    const connector = makeConnector();

    for (const missing of [
      "x-shopify-shop-domain",
      "x-shopify-webhook-id",
      "x-shopify-topic",
    ]) {
      expect(() =>
        connector.readEnvelope(headers({ [missing]: undefined })),
      ).toThrow("Required Shopify webhook headers are missing");
    }
  });
});

describe("ShopifyConnector.mapTopic", () => {
  const connector = makeConnector();

  it.each([
    ["orders/create", { kind: "ORDER_UPSERT" }],
    ["orders/updated", { kind: "ORDER_UPSERT" }],
    ["orders/cancelled", { kind: "ORDER_UPSERT" }],
    ["app/uninstalled", { kind: "STORE_DISCONNECTED" }],
    ["customers/data_request", { kind: "PRIVACY_REQUEST" }],
    ["customers/redact", { kind: "PRIVACY_REQUEST" }],
    ["shop/redact", { kind: "PRIVACY_REQUEST" }],
    [
      "products/create",
      { kind: "IGNORED", reason: "Unsupported webhook topic" },
    ],
  ])("maps %s to the documented intent", (topic, intent) => {
    expect(connector.mapTopic(topic)).toEqual(intent);
  });
});

describe("ShopifyConnector.verifyDelivery", () => {
  const envelope = {
    storeKey: "techmart-lab.myshopify.com",
    externalEventId: "wh-1",
    topic: "orders/create",
  };

  it("accepts a correctly signed delivery against the environment secret", async () => {
    const connector = makeConnector({
      SHOPIFY_WEBHOOK_SECRET: "env-secret",
    });

    await expect(
      connector.verifyDelivery({
        rawBody: RAW_BODY,
        headers: headers({
          "x-shopify-hmac-sha256": signShopifyWebhookPayload(
            RAW_BODY,
            "env-secret",
          ),
        }),
        store: { id: "store-1", encryptedWebhookSecret: null },
        envelope,
      }),
    ).resolves.toBeUndefined();
  });

  it("prefers the store-specific secret and does not fall back on mismatch", async () => {
    const connector = makeConnector({
      ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
      SHOPIFY_WEBHOOK_SECRET: "env-secret",
    });

    const store = {
      id: "store-1",
      encryptedWebhookSecret: encryptSecret(
        "store-secret",
        TEST_ENCRYPTION_KEY,
      ),
    };

    await expect(
      connector.verifyDelivery({
        rawBody: RAW_BODY,
        headers: headers({
          "x-shopify-hmac-sha256": signShopifyWebhookPayload(
            RAW_BODY,
            "store-secret",
          ),
        }),
        store,
        envelope,
      }),
    ).resolves.toBeUndefined();

    await expect(
      connector.verifyDelivery({
        rawBody: RAW_BODY,
        headers: headers({
          "x-shopify-hmac-sha256": signShopifyWebhookPayload(
            RAW_BODY,
            "env-secret",
          ),
        }),
        store,
        envelope,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects forged and missing signatures before anything is stored", async () => {
    const connector = makeConnector({ SHOPIFY_WEBHOOK_SECRET: "env-secret" });

    await expect(
      connector.verifyDelivery({
        rawBody: RAW_BODY,
        headers: headers({
          "x-shopify-hmac-sha256": signShopifyWebhookPayload(
            RAW_BODY,
            "wrong-secret",
          ),
        }),
        store: { id: "store-1", encryptedWebhookSecret: null },
        envelope,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    await expect(
      connector.verifyDelivery({
        rawBody: RAW_BODY,
        headers: headers({ "x-shopify-hmac-sha256": undefined }),
        store: { id: "store-1", encryptedWebhookSecret: null },
        envelope,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

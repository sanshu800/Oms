import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  signShopifyWebhookPayload,
  verifyShopifyWebhook,
} from "./shopify-signature";

const SECRET = "test-webhook-secret";

function referenceSignature(rawBody: Buffer | string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("base64");
}

describe("signShopifyWebhookPayload", () => {
  it("matches a reference base64 HMAC-SHA256 over the raw body", () => {
    const rawBody = Buffer.from(JSON.stringify({ id: 1, name: "#1001" }));

    expect(signShopifyWebhookPayload(rawBody, SECRET)).toBe(
      referenceSignature(rawBody, SECRET),
    );
  });

  it("signs string input identically to its utf8 bytes", () => {
    const body = '{"id":1}';

    expect(signShopifyWebhookPayload(body, SECRET)).toBe(
      referenceSignature(Buffer.from(body, "utf8"), SECRET),
    );
  });
});

describe("verifyShopifyWebhook", () => {
  const rawBody = Buffer.from(JSON.stringify({ id: 1, name: "#1001" }));
  const signature = referenceSignature(rawBody, SECRET);

  it("accepts a correctly signed delivery", () => {
    expect(verifyShopifyWebhook(rawBody, signature, SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const tampered = Buffer.from(JSON.stringify({ id: 2, name: "#1001" }));

    expect(verifyShopifyWebhook(tampered, signature, SECRET)).toBe(false);
  });

  it("rejects a signature made with a different secret", () => {
    const wrongSecretSignature = referenceSignature(rawBody, "other-secret");

    expect(verifyShopifyWebhook(rawBody, wrongSecretSignature, SECRET)).toBe(
      false,
    );
  });

  it("rejects a missing signature", () => {
    expect(verifyShopifyWebhook(rawBody, undefined, SECRET)).toBe(false);
    expect(verifyShopifyWebhook(rawBody, "", SECRET)).toBe(false);
  });

  it("rejects a signature of a different length without throwing", () => {
    expect(verifyShopifyWebhook(rawBody, "c2hvcnQ=", SECRET)).toBe(false);
    expect(
      verifyShopifyWebhook(rawBody, `${signature}AAAA`, SECRET),
    ).toBe(false);
  });

  it("rejects a valid-length but altered signature", () => {
    const flipped = `${signature.slice(0, -1)}${
      signature.at(-1) === "A" ? "B" : "A"
    }`;

    expect(verifyShopifyWebhook(rawBody, flipped, SECRET)).toBe(false);
  });
});

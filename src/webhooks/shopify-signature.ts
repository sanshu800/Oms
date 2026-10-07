import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The HMAC Shopify sends in `X-Shopify-Hmac-Sha256` is the base64
 * SHA-256 of the *raw* request body keyed with the app's webhook secret.
 */
export function signShopifyWebhookPayload(
  rawBody: Buffer | string,
  secret: string,
): string {
  return createHmac("sha256", secret).update(rawBody).digest("base64");
}

export function verifyShopifyWebhook(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = Buffer.from(signShopifyWebhookPayload(rawBody, secret));
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

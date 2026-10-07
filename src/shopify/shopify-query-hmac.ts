import { createHmac, timingSafeEqual } from "crypto";

function canonicalizeQuery(
  query: Record<string, unknown>,
): string {
  return Object.entries(query)
    .filter(([key]) => key !== "hmac" && key !== "signature")
    .map(([key, value]) => {
      if (Array.isArray(value)) {
        return `${key}=${value.join(",")}`;
      }

      return `${key}=${String(value ?? "")}`;
    })
    .sort()
    .join("&");
}

export function verifyShopifyQueryHmac(
  query: Record<string, unknown>,
  secret: string,
): boolean {
  const providedHmac = query.hmac;

  if (
    typeof providedHmac !== "string" ||
    !/^[a-f0-9]{64}$/i.test(providedHmac)
  ) {
    return false;
  }

  const message = canonicalizeQuery(query);

  const expectedHmac = createHmac("sha256", secret)
    .update(message)
    .digest("hex");

  const providedBuffer = Buffer.from(providedHmac, "utf8");
  const expectedBuffer = Buffer.from(expectedHmac, "utf8");

  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

export function isValidShopDomain(shop: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop);
}
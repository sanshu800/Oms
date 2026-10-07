import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

export function encryptSecret(plaintext: string, secret: string): string {
  const key = deriveKey(secret);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();

  return [
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptSecret(encrypted: string, secret: string): string {
  const [ivPart, tagPart, ciphertextPart] = encrypted.split(".");

  if (!ivPart || !tagPart || !ciphertextPart) {
    throw new Error("Invalid encrypted secret format");
  }

  const key = deriveKey(secret);
  const iv = Buffer.from(ivPart, "base64url");
  const tag = Buffer.from(tagPart, "base64url");
  const ciphertext = Buffer.from(ciphertextPart, "base64url");

  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

export function createSignedState(
  shop: string,
  secret: string,
  ttlSeconds = 600,
): string {
  const payload = {
    shop,
    nonce: randomBytes(32).toString("base64url"),
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };

  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");

  const signature = createHmac("sha256", secret)
    .update(encoded)
    .digest("base64url");

  return `${encoded}.${signature}`;
}

export function verifySignedState(
  state: string,
  expectedShop: string,
  secret: string,
): boolean {
  const [encoded, providedSignature] = state.split(".");

  if (!encoded || !providedSignature) {
    return false;
  }

  const expectedSignature = createHmac("sha256", secret)
    .update(encoded)
    .digest("base64url");

  const provided = Buffer.from(providedSignature);
  const expected = Buffer.from(expectedSignature);

  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return false;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as {
      shop?: string;
      exp?: number;
      nonce?: string;
    };

    if (
      payload.shop !== expectedShop ||
      !payload.nonce ||
      typeof payload.exp !== "number"
    ) {
      return false;
    }

    return payload.exp >= Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

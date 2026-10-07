import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@prisma/client", () => import("../../test-utils/prisma-client.mock"));

import { ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";

import { encryptSecret } from "../shopify/shopify-auth.crypto";
import { signShopifyWebhookPayload } from "./shopify-signature";
import { WebhookIntakeService } from "./webhook-intake.service";

const TEST_ENCRYPTION_KEY = "test-encryption-key-for-webhook-secrets";
const ENV_WEBHOOK_SECRET = "env_webhook_secret";
const STORE_WEBHOOK_SECRET = "store_specific_webhook_secret";

/**
 * These tests pin the two intake guarantees that keep Shopify deliveries
 * from being silently lost:
 *
 * 1. the delivery is stored before anything else happens, and
 * 2. queueing is bounded — an unreachable Redis must produce a 503 (so
 *    Shopify retries) and a FAILED row we can replay, never a request
 *    that hangs past Shopify's 5 second limit.
 */

function createService(options: {
  eventStatus?: string;
  enqueue?: () => Promise<void>;
  enqueueTimeoutMs?: number;
  /** null (default) = store has no secret and the env secret is used. */
  storeWebhookSecret?: string | null;
  shopFound?: boolean;
  envWebhookSecret?: string | null;
} = {}) {
  const stored = {
    id: "event-1",
    tenantId: "tenant-1",
    storeId: "store-1",
    status: options.eventStatus ?? "RECEIVED",
  };

  const prisma = {
    runAsSystem: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    storeConnection: {
      findUnique: vi.fn(async () =>
        options.shopFound === false
          ? null
          : {
              id: "store-1",
              tenantId: "tenant-1",
              encryptedWebhookSecret:
                options.storeWebhookSecret == null
                  ? null
                  : encryptSecret(options.storeWebhookSecret, TEST_ENCRYPTION_KEY),
            },
      ),
    },
    webhookEvent: {
      upsert: vi.fn(async () => ({ ...stored })),
      update: vi.fn(async () => ({ ...stored })),
    },
  };

  const queue = {
    enqueue: vi.fn(options.enqueue ?? (async () => undefined)),
    requeue: vi.fn(options.enqueue ?? (async () => undefined)),
  };

  // Key-aware: the service asks for both the enqueue deadline and secrets.
  const configValues: Record<string, unknown> = {
    WEBHOOK_ENQUEUE_TIMEOUT_MS: options.enqueueTimeoutMs ?? 4000,
    ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    SHOPIFY_WEBHOOK_SECRET:
      options.envWebhookSecret === undefined
        ? ENV_WEBHOOK_SECRET
        : options.envWebhookSecret,
  };

  const configService = {
    get: vi.fn((key: string) => configValues[key]),
  };

  const service = new WebhookIntakeService(
    prisma as never,
    queue as never,
    configService as never,
  );

  return { service, prisma, queue };
}

const RAW_BODY = Buffer.from(JSON.stringify({ id: 1 }), "utf8");

/** A delivery signed with whatever secret the case under test expects. */
function rawDelivery(secret: string, overrides: Record<string, unknown> = {}) {
  return {
    shopDomain: "techmart-lab.myshopify.com",
    webhookId: "wh-1",
    topic: "orders/create",
    payload: { id: 1 },
    payloadSha256: "deadbeef",
    rawBody: RAW_BODY,
    signature: signShopifyWebhookPayload(RAW_BODY, secret),
    ...overrides,
  };
}

// The default fixture is signed with the environment secret, which is what a
// store without its own secret verifies against.
const delivery = rawDelivery(ENV_WEBHOOK_SECRET);

describe("WebhookIntakeService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("stores a new delivery and marks it for queueing", async () => {
    const { service, prisma } = createService();

    const recorded = await service.recordShopifyDelivery(delivery);

    expect(recorded).toEqual({
      webhookEventId: "event-1",
      shouldEnqueue: true,
      resetForRetry: false,
    });
    expect(prisma.webhookEvent.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.webhookEvent.update).not.toHaveBeenCalled();
  });

  it("accepts a processed duplicate without queueing it again", async () => {
    const { service, queue } = createService({ eventStatus: "PROCESSED" });

    const recorded = await service.recordShopifyDelivery(delivery);

    expect(recorded.shouldEnqueue).toBe(false);
    await service.enqueueForProcessing(recorded);
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(queue.requeue).not.toHaveBeenCalled();
  });

  it("resets a previously failed delivery and clears the stale job", async () => {
    const { service, prisma, queue } = createService({ eventStatus: "FAILED" });

    const recorded = await service.recordShopifyDelivery(delivery);

    expect(recorded).toEqual({
      webhookEventId: "event-1",
      shouldEnqueue: true,
      resetForRetry: true,
    });
    expect(prisma.webhookEvent.update).toHaveBeenCalledWith({
      where: { id: "event-1" },
      data: { status: "RECEIVED", attempts: 0, lastError: null },
    });

    await service.enqueueForProcessing(recorded);
    // Jobs deduplicate by id, and failed jobs are retained: re-adding
    // without removing first would be a no-op.
    expect(queue.requeue).toHaveBeenCalledWith("event-1");
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("marks the event failed and answers 503 when the queue rejects", async () => {
    const { service, prisma } = createService({
      enqueue: async () => {
        throw new Error("Redis connection refused");
      },
    });

    const recorded = await service.recordShopifyDelivery(delivery);

    await expect(service.enqueueForProcessing(recorded)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    expect(prisma.webhookEvent.update).toHaveBeenCalledWith({
      where: { id: "event-1" },
      data: { status: "FAILED", lastError: "Redis connection refused" },
    });
  });

  it("fails fast when queueing exceeds the deadline", async () => {
    const { service, prisma } = createService({
      enqueueTimeoutMs: 250,
      enqueue: () => new Promise<void>(() => undefined),
    });

    const recorded = await service.recordShopifyDelivery(delivery);

    await expect(service.enqueueForProcessing(recorded)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    expect(prisma.webhookEvent.update).toHaveBeenCalledWith({
      where: { id: "event-1" },
      data: expect.objectContaining({ status: "FAILED" }),
    });
  });
  /**
   * The secret belongs to the app installed on the store, not to the
   * deployment: an admin-created custom app has its own API secret key, so
   * one global secret silently rejects a second store's deliveries — and
   * Shopify deletes a subscription that keeps failing.
   */
  it("verifies a store-specific secret in preference to the environment secret", async () => {
    const { service, prisma } = createService({
      storeWebhookSecret: STORE_WEBHOOK_SECRET,
    });

    const recorded = await service.recordShopifyDelivery(
      rawDelivery(STORE_WEBHOOK_SECRET),
    );

    expect(recorded.shouldEnqueue).toBe(true);
    expect(prisma.webhookEvent.upsert).toHaveBeenCalledTimes(1);
  });

  it("rejects a delivery signed with the environment secret when the store has its own", async () => {
    const { service, prisma } = createService({
      storeWebhookSecret: STORE_WEBHOOK_SECRET,
    });

    await expect(
      service.recordShopifyDelivery(rawDelivery(ENV_WEBHOOK_SECRET)),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    // Nothing authenticated may become replayable work.
    expect(prisma.webhookEvent.upsert).not.toHaveBeenCalled();
  });

  it("verifies with the environment secret when the store has none (OAuth apps)", async () => {
    const { service } = createService({ storeWebhookSecret: null });

    await expect(
      service.recordShopifyDelivery(rawDelivery(ENV_WEBHOOK_SECRET)),
    ).resolves.toEqual({
      webhookEventId: "event-1",
      shouldEnqueue: true,
      resetForRetry: false,
    });
  });

  it("rejects a forged or missing signature before storing anything", async () => {
    const { service, prisma } = createService();

    await expect(
      service.recordShopifyDelivery({
        ...delivery,
        signature: signShopifyWebhookPayload(RAW_BODY, "wrong-secret"),
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    await expect(
      service.recordShopifyDelivery({ ...delivery, signature: undefined }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(prisma.webhookEvent.upsert).not.toHaveBeenCalled();
  });

  it("rejects an unknown shop instead of acting on it", async () => {
    const { service, prisma } = createService({ shopFound: false });

    await expect(service.recordShopifyDelivery(delivery)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(prisma.webhookEvent.upsert).not.toHaveBeenCalled();
  });

  it("explains the misconfiguration when no secret exists at all", async () => {
    const { service } = createService({
      storeWebhookSecret: null,
      envWebhookSecret: null,
    });

    await expect(service.recordShopifyDelivery(delivery)).rejects.toThrow(
      /SHOPIFY_WEBHOOK_SECRET is not configured/,
    );
  });
});

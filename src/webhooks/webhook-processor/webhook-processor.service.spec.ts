import { beforeEach, describe, expect, it, vi } from "vitest";

import { WebhookStatus } from "@prisma/client";

import { WebhookProcessorService } from "./webhook-processor.service";

describe("WebhookProcessorService", () => {
  let service: WebhookProcessorService;

  const prisma = {
    webhookEvent: {
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    shopifyOrderSnapshot: {
      upsert: vi.fn(),
    },
    // Real PrismaService's RLS context helpers just run the callback
    // directly here — the point of these specs is the webhook logic,
    // not the RLS plumbing (covered separately by prisma.service specs).
    runAsSystem: vi.fn((fn: () => unknown) => fn()),
    runAsTenant: vi.fn((_tenantId: string, fn: () => unknown) => fn()),
  };

  const orderService = {
    upsertFromShopify: vi.fn(),
  };

  const auditService = {
    recordEvent: vi.fn(),
  };

  const exceptionService = {
    createOrUpdateException: vi.fn(),
  };

  const resolutionService = {
    claim: vi.fn(),
    resolve: vi.fn(),
  };

  const baseEvent = {
    id: "event-1",
    tenantId: "tenant-1",
    storeId: "store-1",
    topic: "orders/create",
    shopifyEventId: "shopify-event-1",
    payload: {
      id: 1001,
      name: "#1001",
      financial_status: "paid",
      fulfillment_status: null,
      created_at: "2026-08-18T10:00:00.000Z",
      updated_at: "2026-08-18T10:00:00.000Z",
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();

    service = new WebhookProcessorService(
      prisma as any,
      orderService as any,
      auditService as any,
      exceptionService as any,
      resolutionService as any,
    );

    prisma.webhookEvent.updateMany.mockResolvedValue({
      count: 1,
    });

    prisma.webhookEvent.findUnique.mockResolvedValue(baseEvent);

    prisma.webhookEvent.update.mockResolvedValue(baseEvent);

    prisma.shopifyOrderSnapshot.upsert.mockResolvedValue({});

    orderService.upsertFromShopify.mockResolvedValue({
      id: "order-1",
      externalOrderId: "1001",
      orderNumber: "#1001",
      status: "NEW",
    });
  });

  it("should process an order webhook successfully", async () => {
    await service.processEvent("event-1", {
      attempt: 1,
      maxAttempts: 5,
    });

    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: "event-1",
        status: WebhookStatus.RECEIVED,
      },
      data: {
        status: WebhookStatus.PROCESSING,
      },
    });

    expect(prisma.webhookEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: WebhookStatus.PROCESSED,
          lastError: null,
        }),
      }),
    );
  });

  it("should release the event back to RECEIVED for BullMQ retry", async () => {
    prisma.shopifyOrderSnapshot.upsert.mockRejectedValue(
      new Error("temporary database failure"),
    );

    await expect(
      service.processEvent("event-1", {
        attempt: 1,
        maxAttempts: 5,
      }),
    ).rejects.toThrow("temporary database failure");

    expect(prisma.webhookEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "event-1",
        },
        data: expect.objectContaining({
          status: WebhookStatus.RECEIVED,
          lastError: "temporary database failure",
          attempts: {
            increment: 1,
          },
        }),
      }),
    );

    expect(exceptionService.createOrUpdateException).toHaveBeenCalled();

    expect(auditService.recordEvent).toHaveBeenCalled();
  });

  it("should dead-letter after the final attempt", async () => {
    prisma.shopifyOrderSnapshot.upsert.mockRejectedValue(
      new Error("permanent processing failure"),
    );

    await expect(
      service.processEvent("event-1", {
        attempt: 5,
        maxAttempts: 5,
      }),
    ).rejects.toThrow("permanent processing failure");

    expect(prisma.webhookEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "event-1",
        },
        data: expect.objectContaining({
          status: WebhookStatus.DEAD_LETTER,
          lastError: "permanent processing failure",
          attempts: {
            increment: 1,
          },
        }),
      }),
    );

    expect(exceptionService.createOrUpdateException).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "WEBHOOK_PROCESSING",
        evidence: expect.objectContaining({
          terminal: true,
          attempt: 5,
          maxAttempts: 5,
        }),
        recommendedNextStep:
          "Inspect the webhook payload and processing error. This webhook has exhausted automatic retries and requires manual investigation or replay.",
      }),
    );
  });

  it("should ignore an already claimed event", async () => {
    prisma.webhookEvent.updateMany.mockResolvedValue({
      count: 0,
    });

    await service.processEvent("event-1", {
      attempt: 2,
      maxAttempts: 5,
    });

    expect(prisma.webhookEvent.findUnique).not.toHaveBeenCalled();

    expect(prisma.webhookEvent.update).not.toHaveBeenCalled();
  });

  it("should mark unsupported topics as processed", async () => {
    prisma.webhookEvent.findUnique.mockResolvedValue({
      ...baseEvent,
      topic: "products/create",
    });

    await service.processEvent("event-1", {
      attempt: 1,
      maxAttempts: 5,
    });

    expect(prisma.webhookEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: WebhookStatus.PROCESSED,
        }),
      }),
    );

    expect(orderService.upsertFromShopify).not.toHaveBeenCalled();
  });
});


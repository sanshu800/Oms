import { beforeEach, describe, expect, it, vi } from "vitest";

import { WebhookStatus } from "@prisma/client";

vi.mock("@prisma/client", () => import("../../../test-utils/prisma-client.mock"));

import { ShopifyConnector } from "../../connectors/shopify/shopify.connector";
import { WebhookProcessorService } from "./webhook-processor.service";
import { COMPLIANCE_REST_TOPICS } from "../../shopify/webhook-registration";

describe("WebhookProcessorService", () => {
  let service: WebhookProcessorService;

  const prisma = {
    webhookEvent: {
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    storeConnection: {
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
    upsertFromChannel: vi.fn(),
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
    externalEventId: "shopify-event-1",
    payload: {
      id: 1001,
      name: "#1001",
      financial_status: "paid",
      fulfillment_status: null,
      total_price: "59.90",
      currency: "USD",
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
      [new ShopifyConnector(prisma as any, {} as any)],
    );

    prisma.webhookEvent.updateMany.mockResolvedValue({
      count: 1,
    });

    prisma.webhookEvent.findUnique.mockResolvedValue(baseEvent);

    prisma.webhookEvent.update.mockResolvedValue(baseEvent);

    prisma.storeConnection.findUnique.mockResolvedValue({
      platform: "SHOPIFY",
      status: "ACTIVE",
    });
    prisma.storeConnection.update.mockResolvedValue({});

    prisma.shopifyOrderSnapshot.upsert.mockResolvedValue({});

    orderService.upsertFromChannel.mockResolvedValue({
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

  it.each(["orders/updated", "orders/cancelled"])(
    "should forward %s events to the order lifecycle service",
    async (topic) => {
      prisma.webhookEvent.findUnique.mockResolvedValue({
        ...baseEvent,
        topic,
      });

      await service.processEvent("event-1", {
        attempt: 1,
        maxAttempts: 5,
      });

      expect(orderService.upsertFromChannel).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: "tenant-1",
          storeId: "store-1",
          order: expect.objectContaining({
            externalOrderId: "1001",
            cancelled: topic === "orders/cancelled",
          }),
        }),
      );
    },
  );

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

    expect(orderService.upsertFromChannel).not.toHaveBeenCalled();
  });
  it("disconnects the store and clears its token on app/uninstalled", async () => {
    prisma.webhookEvent.findUnique.mockResolvedValue({
      ...baseEvent,
      topic: "app/uninstalled",
    });

    await service.processEvent("event-1", { attempt: 1, maxAttempts: 5 });

    expect(prisma.storeConnection.update).toHaveBeenCalledWith({
      where: { id: "store-1" },
      data: {
        status: "DISCONNECTED",
        disconnectedAt: expect.any(Date),
        encryptedAccessToken: null,
      },
    });

    expect(orderService.upsertFromChannel).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.update).toHaveBeenCalledWith({
      where: { id: "event-1" },
      data: {
        status: "PROCESSED",
        processedAt: expect.any(Date),
        lastError: null,
      },
    });
    expect(auditService.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "STORE_DISCONNECTED" }),
    );
  });

  it("ignores order events for a disconnected store", async () => {
    prisma.storeConnection.findUnique.mockResolvedValue({
      platform: "SHOPIFY",
      status: "DISCONNECTED",
    });

    await service.processEvent("event-1", { attempt: 1, maxAttempts: 5 });

    expect(orderService.upsertFromChannel).not.toHaveBeenCalled();
    expect(auditService.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "WEBHOOK_IGNORED",
        metadata: expect.objectContaining({
          reason: "Store connection is DISCONNECTED",
        }),
      }),
    );
  });

  it("records a privacy request instead of dropping it", async () => {
    prisma.webhookEvent.findUnique.mockResolvedValue({
      ...baseEvent,
      topic: "customers/redact",
      payload: { shop_id: 1, customer: { id: 42 } },
    });

    await service.processEvent("event-1", { attempt: 1, maxAttempts: 5 });

    expect(orderService.upsertFromChannel).not.toHaveBeenCalled();
    expect(auditService.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "COMPLIANCE_REQUEST_RECEIVED" }),
    );
    expect(exceptionService.createOrUpdateException).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "COMPLIANCE",
        severity: "HIGH",
        fingerprint: expect.stringContaining("customers/redact"),
      }),
    );
  });

  // Regression: the data request is the one privacy topic whose REST name is
  // not a mechanical conversion of its GraphQL name (`customers/data_request`
  // keeps the underscore). Deriving it with a blanket `_ → /` rewrite produced
  // `customers/data/request`, which matched nothing and let the request fall
  // through to the unsupported-topic branch.
  it("records customers/data_request, whose topic name keeps an underscore", async () => {
    prisma.webhookEvent.findUnique.mockResolvedValue({
      ...baseEvent,
      topic: "customers/data_request",
      payload: { shop_id: 1, customer: { id: 42 }, orders_requested: [1001] },
    });

    await service.processEvent("event-1", { attempt: 1, maxAttempts: 5 });

    expect(orderService.upsertFromChannel).not.toHaveBeenCalled();
    expect(auditService.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "COMPLIANCE_REQUEST_RECEIVED" }),
    );
    expect(exceptionService.createOrUpdateException).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "COMPLIANCE",
        severity: "HIGH",
        fingerprint: expect.stringContaining("customers/data_request"),
      }),
    );
  });

  // Every compliance topic the app can register must have a handler. Driving
  // the whole set through the processor is what catches the class of bug where
  // a GraphQL topic name is mechanically rewritten into a REST name that no
  // delivery ever carries: the request is acknowledged, matched against
  // nothing, and dropped — the one outcome Shopify's 30-day window cannot
  // survive.
  it.each(COMPLIANCE_REST_TOPICS)(
    "escalates the %s delivery instead of dropping it",
    async (topic) => {
      prisma.webhookEvent.findUnique.mockResolvedValue({
        ...baseEvent,
        topic,
        payload: { shop_id: 1 },
      });

      await service.processEvent("event-1", { attempt: 1, maxAttempts: 5 });

      expect(orderService.upsertFromChannel).not.toHaveBeenCalled();
      expect(exceptionService.createOrUpdateException).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "COMPLIANCE",
          severity: "HIGH",
          fingerprint: expect.stringContaining(topic),
        }),
      );
      expect(auditService.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: "COMPLIANCE_REQUEST_RECEIVED" }),
      );
      expect(auditService.recordEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: "WEBHOOK_IGNORED" }),
      );
    },
  );

  // A merchant who uninstalled still has data rights: Shopify keeps sending
  // privacy topics after the install is gone, and dropping them would put the
  // store past the 30-day window with no record that a request ever arrived.
  it("still records a privacy request after the store has been disconnected", async () => {
    prisma.storeConnection.findUnique.mockResolvedValue({
      platform: "SHOPIFY",
      status: "DISCONNECTED",
    });
    prisma.webhookEvent.findUnique.mockResolvedValue({
      ...baseEvent,
      topic: "customers/data_request",
      payload: { shop_id: 1, customer: { id: 42 } },
    });

    await service.processEvent("event-1", { attempt: 1, maxAttempts: 5 });

    expect(exceptionService.createOrUpdateException).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "COMPLIANCE",
        severity: "HIGH",
      }),
    );
    expect(auditService.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "COMPLIANCE_REQUEST_RECEIVED" }),
    );
    expect(auditService.recordEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "WEBHOOK_IGNORED" }),
    );
  });
});


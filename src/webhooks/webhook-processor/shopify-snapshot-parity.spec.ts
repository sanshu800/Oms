import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@prisma/client", () => import("../../../test-utils/prisma-client.mock"));

import { PrismaRawOrderSnapshotStore } from "../../connectors/prisma-raw-order-snapshot.store";
import { ShopifyConnector } from "../../connectors/shopify/shopify.connector";
import { WebhookProcessorService } from "./webhook-processor.service";

/**
 * Parity contract for the Shopify raw order snapshot written before
 * canonical processing (decision 8). The parsing moves into the
 * Shopify ChannelConnector; these expectations stay untouched.
 */
describe("Shopify order snapshot parity", () => {
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
    runAsSystem: vi.fn((fn: () => unknown) => fn()),
    runAsTenant: vi.fn((_tenantId: string, fn: () => unknown) => fn()),
  };

  const orderService = {
    upsertFromChannel: vi.fn(),
  };

  const auditService = { recordEvent: vi.fn() };
  const exceptionService = { createOrUpdateException: vi.fn() };
  const resolutionService = { claim: vi.fn(), resolve: vi.fn() };

  const payload = {
    id: 5500000111,
    name: "#1001",
    financial_status: "paid",
    fulfillment_status: null,
    total_price: "59.90",
    currency: "USD",
    created_at: "2026-10-07T09:00:00-04:00",
    updated_at: "2026-10-07T10:00:00-04:00",
    cancelled_at: null,
    line_items: [
      {
        id: 9000000001,
        title: "Red T-Shirt",
        sku: "SKU-RED-TEE",
        variant_id: 44000000001,
        quantity: 2,
        price: "29.95",
      },
    ],
  };

  const baseEvent = {
    id: "event-1",
    tenantId: "tenant-1",
    storeId: "store-1",
    topic: "orders/create",
    externalEventId: "shopify-event-1",
    payload,
  };

  beforeEach(() => {
    vi.clearAllMocks();

    prisma.webhookEvent.updateMany.mockResolvedValue({ count: 1 });
    prisma.webhookEvent.findUnique.mockResolvedValue(baseEvent);
    prisma.webhookEvent.update.mockResolvedValue(baseEvent);
    prisma.storeConnection.findUnique.mockResolvedValue({
      platform: "SHOPIFY",
      status: "ACTIVE",
    });
    prisma.shopifyOrderSnapshot.upsert.mockResolvedValue({});
    orderService.upsertFromChannel.mockResolvedValue({
      id: "order-1",
      externalOrderId: "5500000111",
      orderNumber: "#1001",
      status: "NEW",
    });
  });

  async function process() {
    // The real ShopifyConnector writes through the Prisma-backed snapshot
    // port against the mocked prisma: the write lands in the same
    // prisma.shopifyOrderSnapshot.upsert these tests assert on, byte-for-byte.
    const connector = new ShopifyConnector(
      new PrismaRawOrderSnapshotStore(prisma as any),
      {} as any,
    );
    const service = new WebhookProcessorService(
      prisma as any,
      orderService as any,
      auditService as any,
      exceptionService as any,
      resolutionService as any,
      [connector],
    );
    return service.processEvent("event-1", { attempt: 1, maxAttempts: 5 });
  }

  it("snapshots the raw Shopify order with the exact field mapping", async () => {
    await process();

    expect(prisma.shopifyOrderSnapshot.upsert).toHaveBeenCalledWith({
      where: {
        storeId_shopifyOrderId: {
          storeId: "store-1",
          shopifyOrderId: "5500000111",
        },
      },
      create: {
        tenantId: "tenant-1",
        storeId: "store-1",
        shopifyOrderId: "5500000111",
        orderName: "#1001",
        financialStatus: "paid",
        fulfillmentStatus: "unfulfilled",
        raw: payload,
        createdAtShopify: new Date("2026-10-07T09:00:00-04:00"),
        updatedAtShopify: new Date("2026-10-07T10:00:00-04:00"),
      },
      update: {
        orderName: "#1001",
        financialStatus: "paid",
        fulfillmentStatus: "unfulfilled",
        raw: payload,
        updatedAtShopify: new Date("2026-10-07T10:00:00-04:00"),
      },
    });
  });

  it("defaults orderName to the order id and statuses to the documented fallbacks", async () => {
    prisma.webhookEvent.findUnique.mockResolvedValue({
      ...baseEvent,
      payload: {
        id: 99,
        created_at: "2026-10-07T09:00:00-04:00",
        updated_at: "2026-10-07T09:00:00-04:00",
      },
    });

    // This payload has no order.name, so canonical order ingest fails on
    // it exactly as the pre-refactor OrderService did (same error, after
    // the snapshot is written). The snapshot defaults themselves are the
    // behaviour under test.
    await expect(process()).rejects.toThrow(
      "Missing required Shopify field: order.name",
    );

    const args = prisma.shopifyOrderSnapshot.upsert.mock.calls[0]![0] as any;
    expect(args.create.orderName).toBe("99");
    expect(args.create.financialStatus).toBe("unknown");
    expect(args.create.fulfillmentStatus).toBe("unfulfilled");
    expect(args.create.shopifyOrderId).toBe("99");
  });

  it("passes the normalized order through to canonical upsert", async () => {
    await process();

    expect(orderService.upsertFromChannel).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      storeId: "store-1",
      order: expect.objectContaining({
        externalOrderId: "5500000111",
        orderNumber: "#1001",
        paymentStatus: "paid",
        fulfillmentStatus: "unfulfilled",
        cancelled: false,
      }),
    });

    const orderArg = (orderService.upsertFromChannel as any).mock.calls[0]![0]
      .order;
    expect(orderArg.lines).toHaveLength(1);
    expect(orderArg.lines[0]).toEqual(
      expect.objectContaining({
        externalLineItemId: "9000000001",
        externalItemRef: "44000000001",
        sku: "SKU-RED-TEE",
        title: "Red T-Shirt",
        quantity: 2,
        unitPrice: "29.95",
      }),
    );
  });

  it("rejects a snapshot payload without id with the exact error", async () => {
    prisma.webhookEvent.findUnique.mockResolvedValue({
      ...baseEvent,
      payload: {
        created_at: "2026-10-07T09:00:00-04:00",
        updated_at: "2026-10-07T09:00:00-04:00",
      },
    });

    await expect(process()).rejects.toThrow(
      "Missing required Shopify field: order.id",
    );
  });

  it("rejects a snapshot payload with an invalid updated_at with the exact error", async () => {
    prisma.webhookEvent.findUnique.mockResolvedValue({
      ...baseEvent,
      payload: {
        ...payload,
        updated_at: "not-a-date",
      },
    });

    await expect(process()).rejects.toThrow(
      "Invalid Shopify date: order.updated_at",
    );
  });
});

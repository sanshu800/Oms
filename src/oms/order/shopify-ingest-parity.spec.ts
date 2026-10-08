import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@prisma/client", () => import("../../../test-utils/prisma-client.mock"));

import { Prisma } from "@prisma/client";

import { OrderService } from "./order.service";

/**
 * Parity contract for Shopify order ingest (decision 8).
 *
 * These tests were written against the original `upsertFromShopify`
 * implementation and deliberately keep their expectations untouched
 * while the parsing moves behind the ChannelConnector boundary:
 * only the `ingest()` helper changes when the implementation does.
 * They are the proof that Shopify ingest behaviour is unchanged.
 */
describe("Shopify ingest parity", () => {
  const prisma = {
    order: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    orderItem: {
      create: vi.fn(),
      update: vi.fn(),
    },
  };

  const inventoryService = {
    reserveOrder: vi.fn(),
    releaseOrder: vi.fn(),
    commitOrder: vi.fn(),
    shipOrder: vi.fn(),
  };

  const orderFailureExceptionService = {
    detectAndRaise: vi.fn(),
  };

  let service: OrderService;

  beforeEach(() => {
    vi.clearAllMocks();

    prisma.order.findUnique.mockResolvedValue(null);
    prisma.order.findUniqueOrThrow.mockResolvedValue({ id: "order-1" });
    prisma.order.create.mockImplementation(async (args: any) => ({
      id: "order-1",
      ...args.data,
      items: [],
    }));
    inventoryService.reserveOrder.mockResolvedValue({
      reserved: true,
      reservationCount: 0,
    });

    service = new OrderService(
      prisma as any,
      inventoryService as any,
      orderFailureExceptionService as any,
    );
  });

  async function ingest(input: { payload: unknown; topic?: string }) {
    return (service as any).upsertFromShopify({
      tenantId: "tenant-1",
      storeId: "store-1",
      payload: input.payload,
      topic: input.topic ?? "orders/create",
    });
  }

  const shopifyPayload = {
    id: 5500000111,
    name: "#1001",
    financial_status: "paid",
    fulfillment_status: null,
    total_price: "59.90",
    currency: "USD",
    created_at: "2026-10-07T09:00:00-04:00",
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

  it("creates the OMS order with the exact canonical field mapping", async () => {
    await ingest({ payload: shopifyPayload });

    expect(prisma.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: "tenant-1",
          storeId: "store-1",
          externalOrderId: "5500000111",
          orderNumber: "#1001",
          status: "NEW",
          paymentStatus: "paid",
          fulfillmentStatus: "unfulfilled",
          currency: "USD",
          orderedAt: new Date("2026-10-07T09:00:00-04:00"),
        }),
      }),
    );

    const createArgs = prisma.order.create.mock.calls[0][0] as any;
    expect(String(createArgs.data.totalAmount)).toBe("59.90");
    expect(createArgs.data.totalAmount).toBeInstanceOf(Prisma.Decimal);
  });

  it("maps line items to order items exactly (id, sku, title, quantity, price)", async () => {
    await ingest({ payload: shopifyPayload });

    const createArgs = prisma.order.create.mock.calls[0][0] as any;
    expect(createArgs.data.items.create).toHaveLength(1);

    const line = createArgs.data.items.create[0];
    expect(line.externalLineItemId).toBe("9000000001");
    expect(line.sku).toBe("SKU-RED-TEE");
    expect(line.title).toBe("Red T-Shirt");
    expect(line.quantity).toBe(2);
    expect(line.unitPrice).toBeInstanceOf(Prisma.Decimal);
    expect(String(line.unitPrice)).toBe("29.95");
  });

  it("falls back to variant_id for the SKU and to the SKU for the title when blank", async () => {
    await ingest({
      payload: {
        ...shopifyPayload,
        line_items: [
          {
            id: 7,
            title: "  ",
            sku: "   ",
            variant_id: 42,
            quantity: 1,
            price: "10.00",
          },
        ],
      },
    });

    const line = (prisma.order.create.mock.calls[0][0] as any).data.items
      .create[0];
    expect(line.sku).toBe("42");
    expect(line.title).toBe("42");
    expect(line.externalLineItemId).toBe("7");
  });

  it("creates an already-cancelled order as CANCELLED without reserving stock", async () => {
    await ingest({
      payload: {
        ...shopifyPayload,
        cancelled_at: "2026-10-07T10:00:00-04:00",
      },
    });

    const createArgs = prisma.order.create.mock.calls[0][0] as any;
    expect(createArgs.data.status).toBe("CANCELLED");
    expect(inventoryService.reserveOrder).not.toHaveBeenCalled();
    expect(inventoryService.releaseOrder).not.toHaveBeenCalled();
  });

  it("treats the orders/cancelled topic as cancellation even without cancelled_at", async () => {
    await ingest({ payload: shopifyPayload, topic: "orders/cancelled" });

    const createArgs = prisma.order.create.mock.calls[0][0] as any;
    expect(createArgs.data.status).toBe("CANCELLED");
    expect(inventoryService.reserveOrder).not.toHaveBeenCalled();
  });

  it("accepts numeric ids and prices (Shopify sends both)", async () => {
    await ingest({
      payload: {
        ...shopifyPayload,
        id: 12345,
        total_price: 59.9,
        line_items: [
          {
            id: 9,
            title: "Tee",
            sku: "SKU-1",
            quantity: 3,
            price: 19.95,
          },
        ],
      },
    });

    const createArgs = prisma.order.create.mock.calls[0][0] as any;
    expect(createArgs.data.externalOrderId).toBe("12345");
    expect(String(createArgs.data.totalAmount)).toBe("59.9");
    expect(String(createArgs.data.items.create[0].unitPrice)).toBe("19.95");
  });

  it("rejects a non-object payload with the exact error", async () => {
    await expect(ingest({ payload: [1, 2, 3] })).rejects.toThrow(
      "Shopify order payload must be an object",
    );
    await expect(ingest({ payload: "nope" })).rejects.toThrow(
      "Shopify order payload must be an object",
    );
  });

  it("rejects missing required fields with the exact error", async () => {
    await expect(
      ingest({ payload: { ...shopifyPayload, id: undefined } }),
    ).rejects.toThrow("Missing required Shopify field: order.id");

    await expect(
      ingest({ payload: { ...shopifyPayload, total_price: "" } }),
    ).rejects.toThrow("Missing required Shopify field: order.total_price");

    await expect(
      ingest({ payload: { ...shopifyPayload, currency: undefined } }),
    ).rejects.toThrow("Missing required Shopify field: order.currency");
  });

  it("rejects invalid dates with the exact error", async () => {
    await expect(
      ingest({ payload: { ...shopifyPayload, created_at: "not-a-date" } }),
    ).rejects.toThrow("Invalid Shopify date: order.created_at");

    await expect(
      ingest({ payload: { ...shopifyPayload, created_at: 12345 } }),
    ).rejects.toThrow("Missing required Shopify field: order.created_at");
  });

  it("rejects duplicate line item ids with the exact error", async () => {
    await expect(
      ingest({
        payload: {
          ...shopifyPayload,
          line_items: [
            { id: 5, title: "A", sku: "A", quantity: 1, price: "1.00" },
            { id: 5, title: "B", sku: "B", quantity: 1, price: "2.00" },
          ],
        },
      }),
    ).rejects.toThrow("Duplicate Shopify line item ID: 5");
  });

  it("rejects invalid quantities with the exact error", async () => {
    await expect(
      ingest({
        payload: {
          ...shopifyPayload,
          line_items: [
            { id: 5, title: "A", sku: "A", quantity: 0, price: "1.00" },
          ],
        },
      }),
    ).rejects.toThrow("Invalid quantity for order.line_items[0]");

    await expect(
      ingest({
        payload: {
          ...shopifyPayload,
          line_items: [
            { id: 5, title: "A", sku: "A", quantity: 1.5, price: "1.00" },
          ],
        },
      }),
    ).rejects.toThrow("Invalid quantity for order.line_items[0]");
  });

  it("rejects a line item without id or variant_id fallback with the exact error", async () => {
    await expect(
      ingest({
        payload: {
          ...shopifyPayload,
          line_items: [{ id: 5, title: "A", quantity: 1, price: "1.00" }],
        },
      }),
    ).rejects.toThrow(
      "Missing required Shopify field: order.line_items[0].variant_id",
    );
  });

  it("reserves stock for a new non-cancelled order", async () => {
    await ingest({ payload: shopifyPayload });

    expect(inventoryService.reserveOrder).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      storeId: "store-1",
      orderId: "order-1",
    });
    expect(prisma.order.create).toHaveBeenCalledTimes(1);
    expect(prisma.order.update).not.toHaveBeenCalled();
  });
});

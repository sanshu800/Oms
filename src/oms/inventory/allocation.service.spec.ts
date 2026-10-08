import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@prisma/client", () => import("../../../test-utils/prisma-client.mock"));

import { AllocationService } from "./allocation.service";

describe("AllocationService", () => {
  const tx = {
    $executeRawUnsafe: vi.fn(),
    order: { findFirst: vi.fn() },
    storeConnection: { findFirst: vi.fn() },
    inventoryItem: { findUnique: vi.fn() },
    inventoryItemExternalReference: { findUnique: vi.fn() },
    inventoryBalance: { findMany: vi.fn(), updateMany: vi.fn() },
    inventoryReservation: { findMany: vi.fn(), create: vi.fn() },
    inventoryMovement: { create: vi.fn() },
    orderItem: { update: vi.fn() },
  };
  const prisma = {
    $transaction: vi.fn(),
  };
  let service: AllocationService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation((operation: (transaction: typeof tx) => unknown) =>
      operation(tx),
    );
    service = new AllocationService(prisma as any);

    tx.storeConnection.findFirst.mockResolvedValue({ platform: "SHOPIFY" });
    tx.inventoryItemExternalReference.findUnique.mockResolvedValue(null);
    tx.inventoryItem.findUnique.mockResolvedValue(null);
    tx.inventoryBalance.findMany.mockResolvedValue([]);
  });

  it("ignores retained zero-quantity Shopify lines", async () => {
    tx.order.findFirst.mockResolvedValue({
      id: "order-1",
      items: [
        {
          id: "removed-line-1",
          sku: "SKU-1",
          quantity: 0,
        },
      ],
    });

    await expect(
      service.reserveOrder({
        tenantId: "tenant-1",
        storeId: "store-1",
        orderId: "order-1",
      }),
    ).resolves.toEqual({
      reserved: false,
      reason: "NO_LINE_ITEMS",
      reservationCount: 0,
    });

    expect(tx.inventoryItem.findUnique).not.toHaveBeenCalled();
    expect(tx.inventoryReservation.findMany).not.toHaveBeenCalled();
  });

  it("still rejects negative retained line quantities", async () => {
    tx.order.findFirst.mockResolvedValue({
      id: "order-1",
      items: [
        {
          id: "invalid-line-1",
          sku: "SKU-1",
          quantity: -1,
        },
      ],
    });

    await expect(
      service.reserveOrder({
        tenantId: "tenant-1",
        storeId: "store-1",
        orderId: "order-1",
      }),
    ).rejects.toThrow("Invalid quantity for SKU: SKU-1");
  });

  it("resolves lines through the canonical mapping boundary (decision 4)", async () => {
    tx.order.findFirst.mockResolvedValue({
      id: "order-1",
      items: [
        {
          id: "line-1",
          sku: "CHANNEL-SKU-1",
          externalItemRef: "44000000001",
          quantity: 2,
        },
      ],
    });

    // Primary path: the external reference names the canonical item,
    // even though its canonical SKU differs from the channel SKU.
    tx.inventoryItemExternalReference.findUnique.mockResolvedValue({
      inventoryItem: { id: "mapped-item-1", active: true, sku: "CANONICAL-1" },
    });

    tx.inventoryReservation.findMany.mockResolvedValue([]);
    tx.inventoryBalance.findMany.mockResolvedValue([
      {
        locationId: "loc-1",
        availableQty: 5,
        location: { id: "loc-1", active: true },
      },
    ]);
    tx.inventoryBalance.updateMany.mockResolvedValue({ count: 1 });
    tx.inventoryReservation.create.mockResolvedValue({ id: "reservation-1" });
    tx.inventoryMovement.create.mockResolvedValue({});
    tx.orderItem.update.mockResolvedValue({});

    await expect(
      service.reserveOrder({
        tenantId: "tenant-1",
        storeId: "store-1",
        orderId: "order-1",
      }),
    ).resolves.toEqual({ reserved: true, reservationCount: 1 });

    // The SKU fallback lookup must not run: the mapping is authoritative.
    expect(tx.inventoryItem.findUnique).not.toHaveBeenCalled();
    expect(tx.inventoryItemExternalReference.findUnique).toHaveBeenCalledWith({
      where: {
        storeId_platform_externalId: {
          storeId: "store-1",
          platform: "SHOPIFY",
          externalId: "44000000001",
        },
      },
      include: { inventoryItem: true },
    });

    // The reserved stock belongs to the mapped canonical item.
    expect(tx.orderItem.update).toHaveBeenCalledWith({
      where: { id: "line-1" },
      data: { inventoryItemId: "mapped-item-1" },
    });
  });

  it("falls back to canonical SKU when the line has no mapping (explicit rule)", async () => {
    tx.order.findFirst.mockResolvedValue({
      id: "order-1",
      items: [
        {
          id: "line-1",
          sku: " SKU-1 ",
          externalItemRef: null,
          quantity: 1,
        },
      ],
    });

    tx.inventoryItem.findUnique.mockResolvedValue({
      id: "sku-item-1",
      active: true,
      sku: "SKU-1",
    });

    tx.inventoryReservation.findMany.mockResolvedValue([]);
    tx.inventoryBalance.findMany.mockResolvedValue([
      {
        locationId: "loc-1",
        availableQty: 1,
        location: { id: "loc-1", active: true },
      },
    ]);
    tx.inventoryBalance.updateMany.mockResolvedValue({ count: 1 });
    tx.inventoryReservation.create.mockResolvedValue({ id: "reservation-1" });
    tx.inventoryMovement.create.mockResolvedValue({});
    tx.orderItem.update.mockResolvedValue({});

    await expect(
      service.reserveOrder({
        tenantId: "tenant-1",
        storeId: "store-1",
        orderId: "order-1",
      }),
    ).resolves.toEqual({ reserved: true, reservationCount: 1 });

    expect(tx.inventoryItem.findUnique).toHaveBeenCalledWith({
      where: {
        tenantId_sku: {
          tenantId: "tenant-1",
          sku: "SKU-1",
        },
      },
    });
  });

  it("keeps the historical failure when a line resolves to nothing", async () => {
    tx.order.findFirst.mockResolvedValue({
      id: "order-1",
      items: [
        {
          id: "line-1",
          sku: "UNKNOWN-SKU",
          externalItemRef: "no-mapping",
          quantity: 1,
        },
      ],
    });

    await expect(
      service.reserveOrder({
        tenantId: "tenant-1",
        storeId: "store-1",
        orderId: "order-1",
      }),
    ).rejects.toThrow("Inventory item not found for SKU: UNKNOWN-SKU");
  });
});

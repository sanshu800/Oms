import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@prisma/client", () => import("../../../test-utils/prisma-client.mock"));

import { AllocationService } from "./allocation.service";

describe("AllocationService", () => {
  const tx = {
    $executeRawUnsafe: vi.fn(),
    order: { findFirst: vi.fn() },
    inventoryItem: { findUnique: vi.fn() },
    orderItem: { update: vi.fn() },
    inventoryReservation: { findMany: vi.fn() },
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
});

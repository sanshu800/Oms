import { beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaService } from "../../prisma/prisma.service";
import { ExceptionService } from "../exception/exception.service";
import { InventoryTruthService } from "../inventory/inventory-truth.service";
import { InvestigationContextService } from "./investigation-context.service";

describe("InvestigationContextService", () => {
  const prisma = {
    order: {
      findFirst: vi.fn(),
    },
    inventoryReservation: {
      findMany: vi.fn(),
    },
  };

  const exceptionService = {
    getById: vi.fn(),
  };

  const inventoryTruthService = {
    getSkuTruth: vi.fn(),
  };

  let service: InvestigationContextService;

  beforeEach(() => {
    vi.clearAllMocks();

    service = new InvestigationContextService(
      prisma as any,
      exceptionService as any,
      inventoryTruthService as any,
    );
  });

  it("should assemble exception, current inventory, order item, and reservations", async () => {
    const detectedAt = new Date("2026-08-21T08:00:00.000Z");
    const updatedAt = new Date("2026-08-21T08:05:00.000Z");
    const orderedAt = new Date("2026-08-21T07:55:00.000Z");

    exceptionService.getById.mockResolvedValue({
      id: "exception-1",
      category: "ORDER_OPERATIONAL_RISK",
      severity: "HIGH",
      status: "INVESTIGATING",
      title: "Order has insufficient inventory",
      fingerprint: "ORDER_INVENTORY_FAILURE:order-1:item-1",
      detectedAt,
      updatedAt,
      recommendedNextStep: "Review inventory",
      evidence: {
        detectionStatus: "INSUFFICIENT_INVENTORY",
        orderId: "order-1",
        orderItemId: "item-1",
        sku: "SKU-1",
        requestedQty: 58,
        availableQty: 57,
        shortageQty: 1,
        inventoryItemId: "inventory-1",
      },
    });

    prisma.order.findFirst.mockResolvedValue({
      id: "order-1",
      orderNumber: "#1001",
      status: "FAILED",
      paymentStatus: "PAID",
      fulfillmentStatus: "unfulfilled",
      currency: "USD",
      totalAmount: {
        toString: () => "149.00",
      },
      orderedAt,
      items: [
        {
          id: "item-1",
          sku: "SKU-1",
          title: "Product 1",
          quantity: 58,
          inventoryItemId: "inventory-1",
        },
      ],
    });

    inventoryTruthService.getSkuTruth.mockResolvedValue({
      inventoryItemId: "inventory-1",
      sku: "SKU-1",
      name: "Product 1",
      availableQty: 62,
      reservedQty: 3,
      committedQty: 0,
      onHandQty: 65,
      locationCount: 1,
      isStale: false,
      locations: [],
    });

    prisma.inventoryReservation.findMany.mockResolvedValue([
      {
        id: "reservation-1",
        locationId: "location-1",
        quantity: 58,
        status: "RELEASED",
      },
    ]);

    const result = await service.getContext({
      tenantId: "tenant-1",
      storeId: "store-1",
      exceptionId: "exception-1",
    });

    expect(result.exception.status).toBe("INVESTIGATING");
    expect(result.order?.status).toBe("FAILED");
    expect(result.affectedItem?.sku).toBe("SKU-1");
    expect(result.inventory?.availableQty).toBe(62);
    expect(result.inventory?.isStale).toBe(false);
    expect(result.reservations).toHaveLength(1);

    expect(inventoryTruthService.getSkuTruth).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      sku: "SKU-1",
    });
  });

  it("should reject a missing exception", async () => {
    exceptionService.getById.mockResolvedValue(null);

    await expect(
      service.getContext({
        tenantId: "tenant-1",
        storeId: "store-1",
        exceptionId: "missing",
      }),
    ).rejects.toThrow(
      "Operational exception not found: missing",
    );

    expect(prisma.order.findFirst).not.toHaveBeenCalled();
    expect(inventoryTruthService.getSkuTruth).not.toHaveBeenCalled();
  });

  it("should preserve investigation context when the order is unavailable", async () => {
    exceptionService.getById.mockResolvedValue({
      id: "exception-2",
      category: "ORDER_OPERATIONAL_RISK",
      severity: "HIGH",
      status: "INVESTIGATING",
      title: "Unknown order",
      fingerprint: "fingerprint-2",
      detectedAt: new Date("2026-08-21T08:00:00.000Z"),
      updatedAt: new Date("2026-08-21T08:05:00.000Z"),
      recommendedNextStep: "Investigate",
      evidence: {
        sku: "SKU-2",
      },
    });

    prisma.order.findFirst.mockResolvedValue(null);
    inventoryTruthService.getSkuTruth.mockResolvedValue(null);
    prisma.inventoryReservation.findMany.mockResolvedValue([]);

    const result = await service.getContext({
      tenantId: "tenant-1",
      storeId: "store-1",
      exceptionId: "exception-2",
    });

    expect(result.order).toBeNull();
    expect(result.affectedItem).toBeNull();
    expect(result.inventory).toBeNull();
    expect(result.reservations).toEqual([]);
  });

  it("still renders when the SKU's on-hand balance is invalid (negative), instead of failing the whole view", async () => {
    exceptionService.getById.mockResolvedValue({
      id: "exception-3",
      category: "INVENTORY_INTEGRITY",
      severity: "CRITICAL",
      status: "OPEN",
      title: "Negative inventory detected for SKU-3",
      fingerprint: "fingerprint-3",
      detectedAt: new Date("2026-08-21T08:00:00.000Z"),
      updatedAt: new Date("2026-08-21T08:05:00.000Z"),
      recommendedNextStep: "Reconcile",
      evidence: { sku: "SKU-3" },
    });

    prisma.order.findFirst.mockResolvedValue(null);
    inventoryTruthService.getSkuTruth.mockRejectedValue(
      new Error("Invalid inventory balance for SKU SKU-3: on-hand quantity cannot be negative"),
    );
    prisma.inventoryReservation.findMany.mockResolvedValue([]);

    const result = await service.getContext({
      tenantId: "tenant-1",
      storeId: "store-1",
      exceptionId: "exception-3",
    });

    expect(result.exception.title).toBe("Negative inventory detected for SKU-3");
    expect(result.inventory).toBeNull();
  });
});



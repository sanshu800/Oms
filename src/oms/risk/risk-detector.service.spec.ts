import { describe, expect, it, vi } from "vitest";

import { RiskDetectorService } from "./risk-detector.service";

describe("RiskDetectorService", () => {
  it("should detect negative inventory integrity risk", async () => {
    const prisma = {
      inventoryBalance: {
        findMany: vi.fn().mockResolvedValue([
          {
            inventoryItemId: "inventory-1",
            locationId: "location-1",
            availableQty: -2,
            reservedQty: 0,
            committedQty: 0,
            inventoryItem: {
              sku: "SKU-001",
            },
            location: {
              id: "location-1",
            },
          },
        ]),
      },
      inventoryReservation: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      fulfillment: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      shipment: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      order: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    };

    const exceptionService = {
      createOrUpdateException: vi.fn().mockResolvedValue({
        id: "exception-1",
      }),
    };

    const service = new RiskDetectorService(
      prisma as any,
      exceptionService as any,
    );

    const result = await service.detect({
      tenantId: "tenant-1",
      storeId: "store-1",
    });

    expect(result.detected).toBe(1);

    expect(exceptionService.createOrUpdateException).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        storeId: "store-1",
        category: "INVENTORY_INTEGRITY",
        title: "Negative inventory detected for SKU-001",
      }),
    );
  });
});

import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { OrderFailureDetectorService } from "./order-failure-detector.service";

describe("OrderFailureDetectorService", () => {
  function createService(truth: any) {
    const inventoryTruthService = {
      getSkuTruth: vi.fn().mockResolvedValue(truth),
    };

    return {
      service: new OrderFailureDetectorService(
        inventoryTruthService as any,
      ),
      inventoryTruthService,
    };
  }

  const baseTruth = {
    inventoryItemId: "inventory-1",
    sku: "sku-managed-1",
    name: "The Multi-managed Snowboard",
    availableQty: 57,
    reservedQty: 3,
    committedQty: 0,
    onHandQty: 60,
    locationCount: 2,
    isStale: false,
    locations: [],
  };

  const baseInput = {
    tenantId: "tenant-1",
    orderId: "order-1003",
    orderNumber: "#1003",
    orderItemId: "order-item-1",
    sku: "sku-managed-1",
  };

  it("detects insufficient inventory", async () => {
    const { service } = createService(baseTruth);

    const result = await service.detect({
      ...baseInput,
      requestedQty: 58,
    });

    expect(result.status).toBe(
      "INSUFFICIENT_INVENTORY",
    );
    expect(result.detected).toBe(true);
    expect(result.availableQty).toBe(57);
    expect(result.shortageQty).toBe(1);
  });

  it("allows an order when requested quantity is available", async () => {
    const { service } = createService(baseTruth);

    const result = await service.detect({
      ...baseInput,
      requestedQty: 57,
    });

    expect(result.status).toBe("FULFILLABLE");
    expect(result.detected).toBe(false);
    expect(result.shortageQty).toBe(0);
  });

  it("detects zero availability separately", async () => {
    const { service } = createService({
      ...baseTruth,
      availableQty: 0,
      reservedQty: 60,
      onHandQty: 60,
    });

    const result = await service.detect({
      ...baseInput,
      requestedQty: 1,
    });

    expect(result.status).toBe("ZERO_AVAILABILITY");
    expect(result.detected).toBe(true);
    expect(result.shortageQty).toBe(1);
  });

  it("detects an unknown SKU", async () => {
    const { service } = createService(null);

    const result = await service.detect({
      ...baseInput,
      sku: "does-not-exist",
      requestedQty: 1,
    });

    expect(result.status).toBe("UNKNOWN_SKU");
    expect(result.detected).toBe(true);
    expect(result.availableQty).toBeNull();
    expect(result.inventoryItemId).toBeNull();
  });

  it("does not make an automated decision from stale inventory", async () => {
    const { service } = createService({
      ...baseTruth,
      isStale: true,
      availableQty: 100,
    });

    const result = await service.detect({
      ...baseInput,
      requestedQty: 1,
    });

    expect(result.status).toBe("STALE_INVENTORY");
    expect(result.detected).toBe(true);
    expect(result.reason).toContain("stale");
  });

  it("rejects invalid requested quantity", async () => {
    const { service } = createService(baseTruth);

    await expect(
      service.detect({
        ...baseInput,
        requestedQty: 0,
      }),
    ).rejects.toThrow(
      "requestedQty must be a positive integer",
    );
  });
});

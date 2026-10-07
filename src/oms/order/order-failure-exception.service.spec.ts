import { describe, expect, it, vi } from "vitest";

import { OrderFailureExceptionService } from "./order-failure-exception.service";

describe("OrderFailureExceptionService", () => {
  const baseInput = {
    tenantId: "tenant-1",
    storeId: "store-1",
    orderId: "order-1003",
    orderNumber: "#1003",
    orderItemId: "order-item-1",
    sku: "sku-managed-1",
    requestedQty: 58,
  };

  function createService(detection: any) {
    const detector = {
      detect: vi.fn().mockResolvedValue(detection),
    };

    const exceptionService = {
      createOrUpdateException: vi.fn().mockResolvedValue({
        id: "exception-1",
      }),
    };

    return {
      service: new OrderFailureExceptionService(
        detector as any,
        exceptionService as any,
      ),
      detector,
      exceptionService,
    };
  }

  it("raises an exception for insufficient inventory", async () => {
    const detection = {
      status: "INSUFFICIENT_INVENTORY",
      detected: true,
      orderId: "order-1003",
      orderNumber: "#1003",
      orderItemId: "order-item-1",
      sku: "sku-managed-1",
      requestedQty: 58,
      availableQty: 57,
      shortageQty: 1,
      inventoryItemId: "inventory-1",
      inventoryTruth: {
        locationCount: 2,
        isStale: false,
      },
      reason:
        "Requested quantity exceeds currently available inventory.",
    };

    const { service, exceptionService } =
      createService(detection);

    const result =
      await service.detectAndRaise(baseInput);

    expect(result.detection).toEqual(detection);

    expect(
      exceptionService.createOrUpdateException,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        storeId: "store-1",
        fingerprint:
          "ORDER_INVENTORY_FAILURE:order-1003:order-item-1",
        category: "ORDER_OPERATIONAL_RISK",
        severity: "HIGH",
        title:
          "Order #1003 has insufficient inventory for sku-managed-1",
        evidence: expect.objectContaining({
          detectionStatus: "INSUFFICIENT_INVENTORY",
          orderId: "order-1003",
          sku: "sku-managed-1",
          requestedQty: 58,
          availableQty: 57,
          shortageQty: 1,
          inventoryItemId: "inventory-1",
        }),
      }),
    );

    expect(result.exception).toEqual({
      id: "exception-1",
    });
  });

  it("raises a zero availability exception", async () => {
    const detection = {
      status: "ZERO_AVAILABILITY",
      detected: true,
      orderId: "order-1003",
      orderNumber: "#1003",
      orderItemId: "order-item-1",
      sku: "sku-managed-1",
      requestedQty: 1,
      availableQty: 0,
      shortageQty: 1,
      inventoryItemId: "inventory-1",
      inventoryTruth: {
        locationCount: 2,
        isStale: false,
      },
      reason:
        "The SKU has zero currently available inventory.",
    };

    const { service, exceptionService } =
      createService(detection);

    await service.detectAndRaise(baseInput);

    expect(
      exceptionService.createOrUpdateException,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "ORDER_OPERATIONAL_RISK",
        evidence: expect.objectContaining({
          detectionStatus: "ZERO_AVAILABILITY",
          availableQty: 0,
          shortageQty: 1,
        }),
      }),
    );
  });

  it("raises an unknown SKU exception", async () => {
    const detection = {
      status: "UNKNOWN_SKU",
      detected: true,
      orderId: "order-1003",
      orderNumber: "#1003",
      orderItemId: "order-item-1",
      sku: "unknown-sku",
      requestedQty: 1,
      availableQty: null,
      shortageQty: 1,
      inventoryItemId: null,
      inventoryTruth: null,
      reason:
        "No canonical inventory item exists for this SKU.",
    };

    const { service, exceptionService } =
      createService(detection);

    await service.detectAndRaise({
      ...baseInput,
      sku: "unknown-sku",
      requestedQty: 1,
    });

    expect(
      exceptionService.createOrUpdateException,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        evidence: expect.objectContaining({
          detectionStatus: "UNKNOWN_SKU",
          inventoryItemId: null,
        }),
      }),
    );
  });

  it("raises a stale inventory exception", async () => {
    const detection = {
      status: "STALE_INVENTORY",
      detected: true,
      orderId: "order-1003",
      orderNumber: "#1003",
      orderItemId: "order-item-1",
      sku: "sku-managed-1",
      requestedQty: 1,
      availableQty: 100,
      shortageQty: 0,
      inventoryItemId: "inventory-1",
      inventoryTruth: {
        locationCount: 2,
        isStale: true,
      },
      reason:
        "Inventory truth is stale and should not be trusted for an automated fulfillment decision.",
    };

    const { service, exceptionService } =
      createService(detection);

    await service.detectAndRaise(baseInput);

    expect(
      exceptionService.createOrUpdateException,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        evidence: expect.objectContaining({
          detectionStatus: "STALE_INVENTORY",
          isStale: true,
        }),
      }),
    );
  });

  it("does not create an exception for a fulfillable order", async () => {
    const detection = {
      status: "FULFILLABLE",
      detected: false,
      orderId: "order-1003",
      orderNumber: "#1003",
      orderItemId: "order-item-1",
      sku: "sku-managed-1",
      requestedQty: 57,
      availableQty: 57,
      shortageQty: 0,
      inventoryItemId: "inventory-1",
      inventoryTruth: {
        locationCount: 2,
        isStale: false,
      },
      reason:
        "Requested quantity can be fulfilled from current available inventory.",
    };

    const { service, exceptionService } =
      createService(detection);

    const result =
      await service.detectAndRaise({
        ...baseInput,
        requestedQty: 57,
      });

    expect(result.exception).toBeNull();

    expect(
      exceptionService.createOrUpdateException,
    ).not.toHaveBeenCalled();
  });

  it("uses the same fingerprint for repeated detection", async () => {
    const detection = {
      status: "INSUFFICIENT_INVENTORY",
      detected: true,
      orderId: "order-1003",
      orderNumber: "#1003",
      orderItemId: "order-item-1",
      sku: "sku-managed-1",
      requestedQty: 58,
      availableQty: 57,
      shortageQty: 1,
      inventoryItemId: "inventory-1",
      inventoryTruth: {
        locationCount: 2,
        isStale: false,
      },
      reason: "insufficient",
    };

    const { service, exceptionService } =
      createService(detection);

    await service.detectAndRaise(baseInput);

    await service.detectAndRaise({
      ...baseInput,
      requestedQty: 59,
    });

    expect(
      exceptionService.createOrUpdateException,
    ).toHaveBeenCalledTimes(2);

    const calls =
      exceptionService.createOrUpdateException.mock.calls;

    expect(calls).toHaveLength(2);

    const firstCall = calls[0];
    const secondCall = calls[1];

    expect(firstCall).toBeDefined();
    expect(secondCall).toBeDefined();

    expect(firstCall?.[0]?.fingerprint).toBe(
      "ORDER_INVENTORY_FAILURE:order-1003:order-item-1",
    );

    expect(secondCall?.[0]?.fingerprint).toBe(
      "ORDER_INVENTORY_FAILURE:order-1003:order-item-1",
    );
  });
});

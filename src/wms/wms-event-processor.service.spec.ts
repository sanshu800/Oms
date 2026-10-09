import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@prisma/client", () => import("../../test-utils/prisma-client.mock"));

import { WmsRequestStatus } from "@prisma/client";

import {
  WmsEventProcessorService,
} from "./wms-event-processor.service";
import { WMS_EVENT_TYPES } from "./wms-contract";

describe("WmsEventProcessorService", () => {
  const prisma = {
    runAsSystem: vi.fn(async (fn: () => unknown) => fn()),
    runAsTenant: vi.fn(async (_tenantId: string, fn: () => unknown) => fn()),
    wmsEvent: {
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    wmsConnection: { findUnique: vi.fn() },
    wmsFulfillmentRequest: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    wmsFulfillmentRequestLine: { update: vi.fn() },
  };

  const fulfillmentService = {
    getById: vi.fn(),
    start: vi.fn(),
    cancel: vi.fn(),
    fail: vi.fn(),
    createShipment: vi.fn(),
    shipShipment: vi.fn(),
    complete: vi.fn(),
    getShippedQuantityByFulfillmentItem: vi.fn(),
  };

  const auditService = {
    recordEvent: vi.fn(),
  };

  let service: WmsEventProcessorService;

  function storedEvent(overrides: Record<string, unknown> = {}) {
    return {
      id: "event-1",
      tenantId: "tenant-1",
      connectionId: "connection-1",
      eventType: WMS_EVENT_TYPES.ACKNOWLEDGED,
      externalEventId: "wms-ev-1",
      payload: {
        eventType: WMS_EVENT_TYPES.ACKNOWLEDGED,
        externalEventId: "wms-ev-1",
        requestRef: "fulfillment-1",
        externalRequestId: "fake-wms-fulfillment-1",
        occurredAt: "2026-10-09T10:05:00.000Z",
      },
      ...overrides,
    };
  }

  function request(overrides: Record<string, unknown> = {}) {
    return {
      id: "request-1",
      tenantId: "tenant-1",
      storeId: "store-1",
      connectionId: "connection-1",
      fulfillmentId: "fulfillment-1",
      idempotencyKey: "fulfillment-1",
      status: WmsRequestStatus.SUBMITTED,
      externalRequestId: "fake-wms-fulfillment-1",
      lines: [
        {
          id: "rl-1",
          requestId: "request-1",
          orderItemId: "oi-1",
          externalLineRef: "oi-1",
          sku: "SKU-1",
          quantity: 3,
          pickedQuantity: 0,
          packedQuantity: 0,
          shippedQuantity: 0,
        },
      ],
      ...overrides,
    };
  }

  function fulfillment(overrides: Record<string, unknown> = {}) {
    return {
      id: "fulfillment-1",
      status: "READY",
      items: [
        {
          id: "fi-1",
          orderItemId: "oi-1",
          quantity: 3,
          reservation: { status: "ACTIVE" },
        },
      ],
      ...overrides,
    };
  }

  function process() {
    return service.processEvent("event-1", { attempt: 1, maxAttempts: 5 });
  }

  beforeEach(() => {
    vi.clearAllMocks();

    service = new WmsEventProcessorService(
      prisma as never,
      fulfillmentService as never,
      auditService as never,
    );

    prisma.wmsEvent.updateMany.mockResolvedValue({ count: 1 });
    prisma.wmsEvent.findUnique.mockResolvedValue(storedEvent());
    prisma.wmsConnection.findUnique.mockResolvedValue({
      id: "connection-1",
      tenantId: "tenant-1",
      status: "ACTIVE",
    });
    prisma.wmsFulfillmentRequest.findUnique.mockResolvedValue(request());
    fulfillmentService.getById.mockResolvedValue(fulfillment());
    fulfillmentService.start.mockResolvedValue(fulfillment({ status: "IN_PROGRESS" }));
  });

  it("applies an acknowledgement: fulfillment starts, request acknowledges", async () => {
    await process();

    expect(fulfillmentService.start).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      storeId: "store-1",
      fulfillmentId: "fulfillment-1",
    });

    expect(prisma.wmsFulfillmentRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: WmsRequestStatus.ACKNOWLEDGED,
          externalRequestId: "fake-wms-fulfillment-1",
        }),
      }),
    );

    expect(prisma.wmsEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "PROCESSED" }),
      }),
    );

    expect(auditService.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "WMS_EVENT_APPLIED" }),
    );
  });

  it("records pick progress as cumulative quantities only", async () => {
    prisma.wmsEvent.findUnique.mockResolvedValue(
      storedEvent({
        eventType: WMS_EVENT_TYPES.PICKED,
        payload: {
          eventType: WMS_EVENT_TYPES.PICKED,
          externalEventId: "wms-ev-2",
          requestRef: "fulfillment-1",
          occurredAt: "2026-10-09T10:10:00.000Z",
          lines: [{ externalLineRef: "oi-1", quantity: 2 }],
        },
      }),
    );

    fulfillmentService.getById.mockResolvedValue(
      fulfillment({ status: "IN_PROGRESS" }),
    );

    await process();

    expect(prisma.wmsFulfillmentRequestLine.update).toHaveBeenCalledWith({
      where: { id: "rl-1" },
      data: { pickedQuantity: 2 },
    });

    // Execution progress never touches fulfillment or shipment state.
    expect(fulfillmentService.createShipment).not.toHaveBeenCalled();
    expect(fulfillmentService.start).not.toHaveBeenCalled();
    expect(fulfillmentService.complete).not.toHaveBeenCalled();
  });

  it("rejects a stale pick regression without mutating anything", async () => {
    prisma.wmsEvent.findUnique.mockResolvedValue(
      storedEvent({
        eventType: WMS_EVENT_TYPES.PICKED,
        payload: {
          eventType: WMS_EVENT_TYPES.PICKED,
          externalEventId: "wms-ev-2",
          requestRef: "fulfillment-1",
          occurredAt: "2026-10-09T09:00:00.000Z",
          lines: [{ externalLineRef: "oi-1", quantity: 1 }],
        },
      }),
    );

    prisma.wmsFulfillmentRequest.findUnique.mockResolvedValue(
      request({
        lines: [
          {
            id: "rl-1",
            orderItemId: "oi-1",
            externalLineRef: "oi-1",
            sku: "SKU-1",
            quantity: 3,
            pickedQuantity: 2,
            packedQuantity: 0,
            shippedQuantity: 0,
          },
        ],
      }),
    );

    fulfillmentService.getById.mockResolvedValue(
      fulfillment({ status: "IN_PROGRESS" }),
    );

    await process();

    expect(prisma.wmsFulfillmentRequestLine.update).not.toHaveBeenCalled();
    expect(prisma.wmsEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "PROCESSED",
          rejectionReason: expect.stringContaining("Stale"),
        }),
      }),
    );
  });

  it("rejects quantities above the request", async () => {
    prisma.wmsEvent.findUnique.mockResolvedValue(
      storedEvent({
        eventType: WMS_EVENT_TYPES.PICKED,
        payload: {
          eventType: WMS_EVENT_TYPES.PICKED,
          externalEventId: "wms-ev-2",
          requestRef: "fulfillment-1",
          occurredAt: "2026-10-09T10:10:00.000Z",
          lines: [{ externalLineRef: "oi-1", quantity: 99 }],
        },
      }),
    );

    fulfillmentService.getById.mockResolvedValue(
      fulfillment({ status: "IN_PROGRESS" }),
    );

    await process();

    expect(prisma.wmsFulfillmentRequestLine.update).not.toHaveBeenCalled();
    expect(prisma.wmsEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rejectionReason: expect.stringContaining("exceeds request quantity"),
        }),
      }),
    );
  });

  it("applies a handover: shipment created, shipped, and canonical completion", async () => {
    prisma.wmsEvent.findUnique.mockResolvedValue(
      storedEvent({
        eventType: WMS_EVENT_TYPES.SHIPPED,
        payload: {
          eventType: WMS_EVENT_TYPES.SHIPPED,
          externalEventId: "wms-ev-3",
          requestRef: "fulfillment-1",
          occurredAt: "2026-10-09T11:00:00.000Z",
          lines: [{ externalLineRef: "oi-1", quantity: 3 }],
          shipment: {
            externalShipmentId: "wms-shipment-1",
            carrier: "FAKE-LOGISTICS",
            trackingNumber: "FAKE-1",
          },
        },
      }),
    );

    fulfillmentService.getById.mockResolvedValue(
      fulfillment({ status: "IN_PROGRESS" }),
    );

    fulfillmentService.createShipment.mockResolvedValue({
      id: "shipment-1",
    });

    fulfillmentService.shipShipment.mockResolvedValue({
      id: "shipment-1",
      status: "IN_TRANSIT",
    });

    fulfillmentService.getShippedQuantityByFulfillmentItem.mockResolvedValue(
      new Map([["fi-1", 3]]),
    );

    fulfillmentService.complete.mockResolvedValue(
      fulfillment({ status: "FULFILLED" }),
    );

    await process();

    expect(fulfillmentService.createShipment).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      storeId: "store-1",
      fulfillmentId: "fulfillment-1",
      externalShipmentId: "wms-shipment-1",
      carrier: "FAKE-LOGISTICS",
      service: undefined,
      trackingNumber: "FAKE-1",
      trackingUrl: undefined,
      items: [{ fulfillmentItemId: "fi-1", quantity: 3 }],
    });

    expect(fulfillmentService.shipShipment).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      storeId: "store-1",
      shipmentId: "shipment-1",
    });

    // Shipped bookkeeping is SET from the shipment ledger, not incremented.
    expect(prisma.wmsFulfillmentRequestLine.update).toHaveBeenCalledWith({
      where: { id: "rl-1" },
      data: { shippedQuantity: 3 },
    });

    expect(fulfillmentService.complete).toHaveBeenCalled();

    expect(prisma.wmsFulfillmentRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: WmsRequestStatus.COMPLETED,
        }),
      }),
    );
  });

  it("leaves the request open on a partial handover", async () => {
    prisma.wmsEvent.findUnique.mockResolvedValue(
      storedEvent({
        eventType: WMS_EVENT_TYPES.SHIPPED,
        payload: {
          eventType: WMS_EVENT_TYPES.SHIPPED,
          externalEventId: "wms-ev-3",
          requestRef: "fulfillment-1",
          occurredAt: "2026-10-09T11:00:00.000Z",
          lines: [{ externalLineRef: "oi-1", quantity: 1 }],
          shipment: { externalShipmentId: "wms-shipment-1" },
        },
      }),
    );

    fulfillmentService.getById.mockResolvedValue(
      fulfillment({ status: "IN_PROGRESS" }),
    );

    fulfillmentService.createShipment.mockResolvedValue({ id: "shipment-1" });
    fulfillmentService.shipShipment.mockResolvedValue({ id: "shipment-1" });
    fulfillmentService.getShippedQuantityByFulfillmentItem.mockResolvedValue(
      new Map([["fi-1", 1]]),
    );
    fulfillmentService.complete.mockResolvedValue(
      fulfillment({ status: "PARTIALLY_FULFILLED" }),
    );

    await process();

    expect(fulfillmentService.complete).toHaveBeenCalled();

    expect(prisma.wmsFulfillmentRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { lastError: null },
      }),
    );

    expect(prisma.wmsFulfillmentRequest.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: WmsRequestStatus.COMPLETED,
        }),
      }),
    );
  });

  it("rejects a handover before acknowledgement — nothing is mutated", async () => {
    prisma.wmsEvent.findUnique.mockResolvedValue(
      storedEvent({
        eventType: WMS_EVENT_TYPES.SHIPPED,
        payload: {
          eventType: WMS_EVENT_TYPES.SHIPPED,
          externalEventId: "wms-ev-3",
          requestRef: "fulfillment-1",
          occurredAt: "2026-10-09T11:00:00.000Z",
          lines: [{ externalLineRef: "oi-1", quantity: 1 }],
          shipment: { externalShipmentId: "wms-shipment-1" },
        },
      }),
    );

    // Fulfillment still READY (ack never arrived).
    await process();

    expect(fulfillmentService.createShipment).not.toHaveBeenCalled();
    expect(prisma.wmsEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rejectionReason: expect.stringContaining(
            "Illegal warehouse transition",
          ),
        }),
      }),
    );
  });

  it("rejects unknown event types durably and never applies them", async () => {
    prisma.wmsEvent.findUnique.mockResolvedValue(
      storedEvent({
        eventType: "fulfillment.label_created",
        payload: {
          eventType: "fulfillment.label_created",
          externalEventId: "wms-ev-9",
          requestRef: "fulfillment-1",
          occurredAt: "2026-10-09T11:00:00.000Z",
        },
      }),
    );

    await process();

    expect(fulfillmentService.start).not.toHaveBeenCalled();
    expect(fulfillmentService.createShipment).not.toHaveBeenCalled();
    expect(prisma.wmsEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rejectionReason: expect.stringContaining("Unknown WMS event type"),
        }),
      }),
    );
  });

  it("rejects cross-tenant request references", async () => {
    prisma.wmsFulfillmentRequest.findUnique.mockResolvedValue(
      request({ tenantId: "tenant-2" }),
    );

    await process();

    expect(fulfillmentService.getById).not.toHaveBeenCalled();
    expect(fulfillmentService.start).not.toHaveBeenCalled();
    expect(prisma.wmsEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rejectionReason: expect.stringContaining("different tenant"),
        }),
      }),
    );
  });

  it("rejects unknown request references", async () => {
    prisma.wmsFulfillmentRequest.findUnique.mockResolvedValue(null);

    await process();

    expect(prisma.wmsEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rejectionReason: expect.stringContaining("unknown request"),
        }),
      }),
    );
  });

  it("rejects an externalRequestId identity conflict before mutating", async () => {
    prisma.wmsFulfillmentRequest.findUnique.mockResolvedValue(
      request({ externalRequestId: "someone-elses-id" }),
    );

    await process();

    expect(fulfillmentService.start).not.toHaveBeenCalled();
    expect(prisma.wmsEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rejectionReason: expect.stringContaining("registered as"),
        }),
      }),
    );
  });

  it("applies warehouse failure: fulfillment failed, request failed", async () => {
    prisma.wmsEvent.findUnique.mockResolvedValue(
      storedEvent({
        eventType: WMS_EVENT_TYPES.FAILED,
        payload: {
          eventType: WMS_EVENT_TYPES.FAILED,
          externalEventId: "wms-ev-4",
          requestRef: "fulfillment-1",
          occurredAt: "2026-10-09T11:00:00.000Z",
          failureReason: "stock discrepancy",
        },
      }),
    );

    fulfillmentService.getById.mockResolvedValue(
      fulfillment({ status: "IN_PROGRESS" }),
    );
    fulfillmentService.fail.mockResolvedValue(fulfillment({ status: "FAILED" }));

    await process();

    expect(fulfillmentService.fail).toHaveBeenCalled();
    expect(prisma.wmsFulfillmentRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: WmsRequestStatus.FAILED,
          lastError: "stock discrepancy",
        }),
      }),
    );
  });

  it("applies cancellation: fulfillment cancelled, request cancelled", async () => {
    prisma.wmsEvent.findUnique.mockResolvedValue(
      storedEvent({
        eventType: WMS_EVENT_TYPES.CANCELLED,
        payload: {
          eventType: WMS_EVENT_TYPES.CANCELLED,
          externalEventId: "wms-ev-5",
          requestRef: "fulfillment-1",
          occurredAt: "2026-10-09T11:00:00.000Z",
        },
      }),
    );

    fulfillmentService.getById.mockResolvedValue(
      fulfillment({ status: "IN_PROGRESS" }),
    );
    fulfillmentService.cancel.mockResolvedValue(
      fulfillment({ status: "CANCELLED" }),
    );

    await process();

    expect(fulfillmentService.cancel).toHaveBeenCalled();
    expect(prisma.wmsFulfillmentRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: WmsRequestStatus.CANCELLED,
        }),
      }),
    );
  });

  it("is a no-op for duplicate claims (already processing/processed)", async () => {
    prisma.wmsEvent.updateMany.mockResolvedValue({ count: 0 });

    await process();

    expect(fulfillmentService.start).not.toHaveBeenCalled();
    expect(prisma.wmsEvent.findUnique).not.toHaveBeenCalled();
  });

  it("ignores events for a disconnected warehouse without mutating state", async () => {
    prisma.wmsConnection.findUnique.mockResolvedValue({
      id: "connection-1",
      tenantId: "tenant-1",
      status: "DISCONNECTED",
    });

    await process();

    expect(fulfillmentService.start).not.toHaveBeenCalled();
    expect(prisma.wmsEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "PROCESSED",
          rejectionReason: expect.stringContaining("WMS connection is"),
        }),
      }),
    );
  });

  it("marks transient failures for retry and dead-letters exhausted ones", async () => {
    fulfillmentService.start.mockRejectedValue(new Error("db down"));

    await expect(process()).rejects.toThrow("db down");

    expect(prisma.wmsEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          attempts: { increment: 1 },
          lastError: "db down",
        }),
      }),
    );

    prisma.wmsEvent.update.mockClear();
    fulfillmentService.start.mockRejectedValue(new Error("db down"));

    await expect(
      service.processEvent("event-1", { attempt: 5, maxAttempts: 5 }),
    ).rejects.toThrow("db down");

    expect(prisma.wmsEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "DEAD_LETTER" }),
      }),
    );
  });

  it("runs under the event's tenant (RLS) after the claim", async () => {
    await process();

    expect(prisma.runAsSystem).toHaveBeenCalled();
    expect(prisma.runAsTenant).toHaveBeenCalledWith(
      "tenant-1",
      expect.any(Function),
    );
  });
});

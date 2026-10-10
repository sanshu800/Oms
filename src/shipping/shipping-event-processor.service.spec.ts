import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@prisma/client", () => import("../../test-utils/prisma-client.mock"));

import { ShipmentStatus, WebhookStatus } from "@prisma/client";

import {
  SHIPPING_CONTRACT_VERSION,
  ShippingWireEventType,
} from "./shipping-contract";
import {
  ShippingEventProcessorService,
  ShippingEventRejectionError,
} from "./shipping-event-processor.service";

/**
 * Contract-pinned invariant suite for the shipping event processor:
 *
 * - AWB/label/pickup events NEVER mark shipped (no `shipShipment`).
 * - Only verified carrier handover transitions to IN_TRANSIT.
 * - Cancellation requested vs confirmed are distinct; races preserve the
 *   verified provider state and flag reconciliation.
 * - Duplicates never double-apply; unknown/cross-tenant/out-of-order
 *   events are rejected or quarantined with recorded reasons.
 */
describe("ShippingEventProcessorService", () => {
  const prisma = {
    runAsSystem: vi.fn(async (fn: () => unknown) => fn()),
    runAsTenant: vi.fn(async (_tenantId: string, fn: () => unknown) => fn()),
    shippingEvent: {
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    shippingConnection: {
      findUnique: vi.fn(),
    },
    shipment: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  };

  const fulfillmentService = {
    labelShipment: vi.fn(),
    shipShipment: vi.fn(),
    deliverShipment: vi.fn(),
    cancelShipment: vi.fn(),
    cancel: vi.fn(),
    complete: vi.fn(),
    getById: vi.fn(),
  };

  const auditService = {
    recordEvent: vi.fn(),
  };

  let service: ShippingEventProcessorService;

  function seedEvent(payload: Record<string, unknown>, eventType: string) {
    const event = {
      id: "event-1",
      tenantId: "tenant-1",
      connectionId: "connection-1",
      eventType,
      externalEventId: String(payload.externalEventId ?? "se-1"),
      payload,
      shipmentId: null as string | null,
    };

    prisma.shippingEvent.updateMany.mockResolvedValue({ count: 1 });
    prisma.shippingEvent.findUnique.mockResolvedValue(event);
    prisma.shippingEvent.update.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: "event-1",
        ...(data as object),
      }),
    );
    prisma.shippingConnection.findUnique.mockResolvedValue({
      id: "connection-1",
      tenantId: "tenant-1",
      status: "ACTIVE",
    });

    return event;
  }

  function seedShipment(overrides: Record<string, unknown> = {}) {
    const shipment = {
      id: "shipment-1",
      tenantId: "tenant-1",
      storeId: "store-1",
      fulfillmentId: "fulfillment-1",
      status: ShipmentStatus.LABEL_CREATED,
      externalShipmentId: "ext-1",
      cancellationRequestedAt: null as Date | null,
      ...overrides,
    };

    prisma.shipment.findFirst.mockResolvedValue(shipment);
    prisma.shipment.update.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        ...shipment,
        ...(data as object),
      }),
    );

    fulfillmentService.getById.mockResolvedValue({
      id: "fulfillment-1",
      status: "IN_PROGRESS",
    });

    return shipment;
  }

  function wire(
    type: ShippingWireEventType,
    status: string,
    extra: Record<string, unknown> = {},
  ) {
    return {
      contractVersion: SHIPPING_CONTRACT_VERSION,
      type,
      externalEventId: "se-1",
      externalShipmentId: "ext-1",
      status,
      occurredAt: "2026-10-09T10:00:00.000Z",
      ...extra,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // Stub every mock explicitly (clearAllMocks does not reset implementations).
    prisma.runAsSystem.mockImplementation(async (fn: () => unknown) => fn());
    prisma.runAsTenant.mockImplementation(
      async (_tenantId: string, fn: () => unknown) => fn(),
    );
    fulfillmentService.labelShipment.mockResolvedValue({});
    fulfillmentService.shipShipment.mockResolvedValue({});
    fulfillmentService.deliverShipment.mockResolvedValue({});
    fulfillmentService.cancelShipment.mockResolvedValue({});
    fulfillmentService.cancel.mockResolvedValue({});
    fulfillmentService.complete.mockResolvedValue({ id: "fulfillment-1", status: "FULFILLED" });
    fulfillmentService.getById.mockResolvedValue({
      id: "fulfillment-1",
      status: "IN_PROGRESS",
      shipments: [],
    });
    auditService.recordEvent.mockResolvedValue({});

    service = new ShippingEventProcessorService(
      prisma as never,
      fulfillmentService as never,
      auditService as never,
    );
  });

  // ============================================================
  // Packing / AWB / pickup are NOT shipping
  // ============================================================

  it("never marks shipped from AWB/label creation", async () => {
    seedEvent(
      wire(ShippingWireEventType.SHIPMENT_CREATED, "awb_assigned", {
        awbCode: "AWB-1",
        labelUrl: "https://cdn/label.pdf",
      }),
      ShippingWireEventType.SHIPMENT_CREATED,
    );
    seedShipment({ status: ShipmentStatus.CREATED });

    await service.processEvent("event-1");

    // Label at most — never a handover.
    expect(fulfillmentService.labelShipment).toHaveBeenCalledTimes(1);
    expect(fulfillmentService.shipShipment).not.toHaveBeenCalled();
    expect(fulfillmentService.deliverShipment).not.toHaveBeenCalled();
  });

  it("records pickup scheduling as progress only — no domain transition", async () => {
    seedEvent(
      wire(ShippingWireEventType.TRACKING_UPDATED, "pickup_scheduled"),
      ShippingWireEventType.TRACKING_UPDATED,
    );
    seedShipment();

    await service.processEvent("event-1");

    expect(fulfillmentService.labelShipment).not.toHaveBeenCalled();
    expect(fulfillmentService.shipShipment).not.toHaveBeenCalled();
    expect(fulfillmentService.deliverShipment).not.toHaveBeenCalled();
    expect(fulfillmentService.cancelShipment).not.toHaveBeenCalled();

    // Bookkeeping only.
    const update = (prisma.shipment.update as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as { data: Record<string, unknown> };
    expect(update.data.lastProviderStatus).toBe("pickup_scheduled");
  });

  // ============================================================
  // Only carrier handover marks shipped
  // ============================================================

  it("marks in-transit ONLY from verified carrier handover", async () => {
    seedEvent(
      wire(ShippingWireEventType.TRACKING_UPDATED, "in_transit"),
      ShippingWireEventType.TRACKING_UPDATED,
    );
    seedShipment();

    await service.processEvent("event-1");

    expect(fulfillmentService.shipShipment).toHaveBeenCalledTimes(1);
    expect(fulfillmentService.deliverShipment).not.toHaveBeenCalled();
  });

  it("converges on duplicate handover events without double-applying", async () => {
    seedEvent(
      wire(ShippingWireEventType.TRACKING_UPDATED, "in_transit", {
        externalEventId: "se-2",
      }),
      ShippingWireEventType.TRACKING_UPDATED,
    );
    // Already committed by an earlier handover.
    seedShipment({ status: ShipmentStatus.IN_TRANSIT });

    await service.processEvent("event-1");

    // No second shipShipment (and therefore no second inventory SHIP).
    expect(fulfillmentService.shipShipment).not.toHaveBeenCalled();
  });

  it("delivers from IN_TRANSIT and idempotently on duplicates", async () => {
    seedEvent(
      wire(ShippingWireEventType.TRACKING_DELIVERED, "delivered"),
      ShippingWireEventType.TRACKING_DELIVERED,
    );
    seedShipment({ status: ShipmentStatus.IN_TRANSIT });

    await service.processEvent("event-1");

    expect(fulfillmentService.deliverShipment).toHaveBeenCalledTimes(1);
    expect(fulfillmentService.shipShipment).not.toHaveBeenCalled();

    vi.clearAllMocks();
    fulfillmentService.deliverShipment.mockResolvedValue({});
    auditService.recordEvent.mockResolvedValue({});
    prisma.runAsSystem.mockImplementation(async (fn: () => unknown) => fn());
    prisma.runAsTenant.mockImplementation(
      async (_tenantId: string, fn: () => unknown) => fn(),
    );

    seedEvent(
      wire(ShippingWireEventType.TRACKING_UPDATED, "delivered", {
        externalEventId: "se-3",
      }),
      ShippingWireEventType.TRACKING_UPDATED,
    );
    seedShipment({ status: ShipmentStatus.DELIVERED });

    await service.processEvent("event-1");

    // Duplicate delivery: nothing re-applied.
    expect(fulfillmentService.deliverShipment).not.toHaveBeenCalled();
    expect(fulfillmentService.shipShipment).not.toHaveBeenCalled();
  });

  it("treats an out-of-order delivery (no prior handover event) as carrier evidence, passing through IN_TRANSIT exactly once", async () => {
    seedEvent(
      wire(ShippingWireEventType.TRACKING_DELIVERED, "delivered"),
      ShippingWireEventType.TRACKING_DELIVERED,
    );
    seedShipment({ status: ShipmentStatus.LABEL_CREATED });

    await service.processEvent("event-1");

    expect(fulfillmentService.shipShipment).toHaveBeenCalledTimes(1);
    expect(fulfillmentService.deliverShipment).toHaveBeenCalledTimes(1);
  });

  // ============================================================
  // Cancellation: requested vs confirmed, and the races
  // ============================================================

  it("keeps cancellation REQUESTED as soft bookkeeping — never a status change", async () => {
    seedEvent(
      wire(ShippingWireEventType.CANCELLATION_REQUESTED, "cancellation_requested"),
      ShippingWireEventType.CANCELLATION_REQUESTED,
    );
    seedShipment();

    await service.processEvent("event-1");

    expect(fulfillmentService.cancelShipment).not.toHaveBeenCalled();
    expect(fulfillmentService.cancel).not.toHaveBeenCalled();

    const update = (prisma.shipment.update as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as { data: Record<string, unknown> };
    expect(update.data.status).toBeUndefined();
    expect(update.data.cancellationRequestedAt).toBeInstanceOf(Date);
    expect(update.data.cancellationRequestRef).toBe("se-1");
  });

  it("applies a CONFIRMED cancellation from pre-handover states and releases the order", async () => {
    seedEvent(
      wire(ShippingWireEventType.CANCELLATION_CONFIRMED, "cancelled"),
      ShippingWireEventType.CANCELLATION_CONFIRMED,
    );
    seedShipment();

    await service.processEvent("event-1");

    expect(fulfillmentService.cancelShipment).toHaveBeenCalledTimes(1);
    expect(fulfillmentService.cancel).toHaveBeenCalledTimes(1);
  });

  it("preserves committed handover state when a cancellation REQUEST arrives late, and flags reconciliation", async () => {
    seedEvent(
      wire(ShippingWireEventType.CANCELLATION_REQUESTED, "cancellation_requested"),
      ShippingWireEventType.CANCELLATION_REQUESTED,
    );
    seedShipment({ status: ShipmentStatus.IN_TRANSIT });

    await service.processEvent("event-1");

    // Handover won the race: no cancellation of committed state.
    expect(fulfillmentService.cancelShipment).not.toHaveBeenCalled();

    const update = (prisma.shipment.update as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as { data: Record<string, unknown> };
    expect(update.data.status).toBeUndefined();

    expect(prisma.shipment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          needsReconciliation: true,
          reconciliationReason: expect.stringContaining("Cancellation requested after"),
        }),
      }),
    );
    expect(auditService.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "SHIPPING_RECONCILIATION_FLAGGED" }),
    );
  });

  it("preserves committed handover/delivery when a cancellation CONFIRMATION arrives late, and flags reconciliation", async () => {
    for (const status of [ShipmentStatus.IN_TRANSIT, ShipmentStatus.DELIVERED]) {
      vi.clearAllMocks();
      prisma.runAsSystem.mockImplementation(async (fn: () => unknown) => fn());
      prisma.runAsTenant.mockImplementation(
        async (_tenantId: string, fn: () => unknown) => fn(),
      );
      auditService.recordEvent.mockResolvedValue({});

      seedEvent(
        wire(ShippingWireEventType.CANCELLATION_CONFIRMED, "cancelled", {
          externalEventId: `se-${status}`,
        }),
        ShippingWireEventType.CANCELLATION_CONFIRMED,
      );
      seedShipment({ status });

      await service.processEvent("event-1");

      // The verified provider state (carrier HAS it / it WAS delivered)
      // is preserved — never silently rewritten to CANCELLED.
      expect(fulfillmentService.cancelShipment).not.toHaveBeenCalled();
      expect(prisma.shipment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            needsReconciliation: true,
            reconciliationReason: expect.stringContaining(
              "Provider confirmed cancellation after",
            ),
          }),
        }),
      );
    }
  });

  it("quarantines handover/delivery that arrive after a committed cancellation, and flags reconciliation", async () => {
    for (const [type, status, externalEventId] of [
      [ShippingWireEventType.TRACKING_UPDATED, "in_transit", "se-h"],
      [ShippingWireEventType.TRACKING_DELIVERED, "delivered", "se-d"],
    ] as const) {
      vi.clearAllMocks();
      prisma.runAsSystem.mockImplementation(async (fn: () => unknown) => fn());
      prisma.runAsTenant.mockImplementation(
        async (_tenantId: string, fn: () => unknown) => fn(),
      );
      auditService.recordEvent.mockResolvedValue({});

      seedEvent(
        wire(type, status, { externalEventId }),
        type,
      );
      seedShipment({ status: ShipmentStatus.CANCELLED });

      await service.processEvent("event-1");

      // No mutation of the committed cancellation.
      expect(fulfillmentService.shipShipment).not.toHaveBeenCalled();
      expect(fulfillmentService.deliverShipment).not.toHaveBeenCalled();

      // Quarantined with a recorded reason...
      expect(prisma.shippingEvent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: WebhookStatus.PROCESSED,
            rejectionReason: expect.stringContaining("Out-of-order shipping event"),
          }),
        }),
      );

      // ...and the discrepancy is flagged.
      expect(prisma.shipment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ needsReconciliation: true }),
        }),
      );
    }
  });

  it("treats a duplicate cancellation confirmation as a no-op", async () => {
    seedEvent(
      wire(ShippingWireEventType.CANCELLATION_CONFIRMED, "cancelled"),
      ShippingWireEventType.CANCELLATION_CONFIRMED,
    );
    seedShipment({ status: ShipmentStatus.CANCELLED });

    await service.processEvent("event-1");

    expect(fulfillmentService.cancelShipment).not.toHaveBeenCalled();
    expect(fulfillmentService.cancel).not.toHaveBeenCalled();
  });

  // ============================================================
  // Cancellation semantics on partially shipped fulfillments
  // (Stage 2.1): preserve completed shipment history, prevent
  // incorrect inventory release.
  // ============================================================

  it("on a PARTIALLY SHIPPED fulfillment: cancels only the target shipment, preserves shipped history, releases NOTHING, and flags reconciliation", async () => {
    seedEvent(
      wire(ShippingWireEventType.CANCELLATION_CONFIRMED, "cancelled"),
      ShippingWireEventType.CANCELLATION_CONFIRMED,
    );
    seedShipment({ status: ShipmentStatus.LABEL_CREATED });

    // The fulfillment already has a physically shipped sibling.
    fulfillmentService.getById.mockResolvedValue({
      id: "fulfillment-1",
      status: "PARTIALLY_FULFILLED",
      shipments: [
        { id: "shipment-0", status: ShipmentStatus.IN_TRANSIT },
        { id: "shipment-1", status: ShipmentStatus.LABEL_CREATED },
      ],
    });

    await service.processEvent("event-1");

    // Only the cancelled shipment transitions — history preserved.
    expect(fulfillmentService.cancelShipment).toHaveBeenCalledTimes(1);
    expect(fulfillmentService.cancelShipment).toHaveBeenCalledWith(
      expect.objectContaining({ shipmentId: "shipment-1" }),
    );
    expect(fulfillmentService.shipShipment).not.toHaveBeenCalled();
    expect(fulfillmentService.deliverShipment).not.toHaveBeenCalled();

    // NEVER release inventory once units have shipped: releaseOrder frees
    // whole ACTIVE reservations (shipped units included) — an over-release.
    expect(fulfillmentService.cancel).not.toHaveBeenCalled();

    // The discrepancy is flagged for reconciliation.
    expect(prisma.shipment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "shipment-1" },
        data: expect.objectContaining({
          needsReconciliation: true,
          reconciliationReason: expect.stringContaining("partially shipped"),
        }),
      }),
    );
  });

  it("when siblings are live but nothing has shipped: cancels only the target, releases NOTHING (would free sibling reservations), and does not flag", async () => {
    seedEvent(
      wire(ShippingWireEventType.CANCELLATION_CONFIRMED, "cancelled"),
      ShippingWireEventType.CANCELLATION_CONFIRMED,
    );
    seedShipment({ status: ShipmentStatus.CREATED });

    fulfillmentService.getById.mockResolvedValue({
      id: "fulfillment-1",
      status: "IN_PROGRESS",
      shipments: [
        { id: "shipment-0", status: ShipmentStatus.CREATED },
        { id: "shipment-1", status: ShipmentStatus.CREATED },
      ],
    });

    await service.processEvent("event-1");

    expect(fulfillmentService.cancelShipment).toHaveBeenCalledTimes(1);
    expect(fulfillmentService.cancel).not.toHaveBeenCalled();

    // No state conflict — an audit record, not a reconciliation flag.
    expect(prisma.shipment.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ needsReconciliation: true }),
      }),
    );
    expect(auditService.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "SHIPPING_SHIPMENT_CANCELLED" }),
    );
  });

  it("when the cancelled shipment is the last live one and nothing shipped: full cancel and a CORRECT inventory release", async () => {
    seedEvent(
      wire(ShippingWireEventType.CANCELLATION_CONFIRMED, "cancelled"),
      ShippingWireEventType.CANCELLATION_CONFIRMED,
    );
    seedShipment({ status: ShipmentStatus.LABEL_CREATED });

    fulfillmentService.getById.mockResolvedValue({
      id: "fulfillment-1",
      status: "IN_PROGRESS",
      shipments: [
        // Only cancelled siblings remain: every unit is still in the
        // warehouse, so releaseOrder is correct here.
        { id: "shipment-0", status: ShipmentStatus.CANCELLED },
        { id: "shipment-1", status: ShipmentStatus.LABEL_CREATED },
      ],
    });

    await service.processEvent("event-1");

    expect(fulfillmentService.cancelShipment).toHaveBeenCalledTimes(1);
    expect(fulfillmentService.cancel).toHaveBeenCalledTimes(1);
  });

  it("commits inventory (complete) BEFORE the SHIP transition at handover — the canonical FULFILLING->FULFILLED order", async () => {
    seedEvent(
      wire(ShippingWireEventType.TRACKING_UPDATED, "in_transit"),
      ShippingWireEventType.TRACKING_UPDATED,
    );
    seedShipment();

    await service.processEvent("event-1");

    expect(fulfillmentService.complete).toHaveBeenCalledTimes(1);
    expect(fulfillmentService.shipShipment).toHaveBeenCalledTimes(1);

    // complete() (inventory COMMIT) must precede shipShipment() (inventory
    // SHIP): the reverse order makes shipOrder a silent no-op against the
    // real InventoryService (COMMITTED -> SHIPPED) and strands reservations.
    expect(
      (fulfillmentService.complete as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0]!,
    ).toBeLessThan(
      (fulfillmentService.shipShipment as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0]!,
    );
  });

  // ============================================================
  // Unknown / cross-tenant / invalid input
  // ============================================================

  it("quarantines events for unknown shipments without mutation", async () => {
    seedEvent(
      wire(ShippingWireEventType.TRACKING_UPDATED, "in_transit"),
      ShippingWireEventType.TRACKING_UPDATED,
    );
    prisma.shipment.findFirst.mockResolvedValue(null);

    await service.processEvent("event-1");

    expect(fulfillmentService.shipShipment).not.toHaveBeenCalled();
    expect(prisma.shippingEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rejectionReason: expect.stringContaining("unknown shipment"),
        }),
      }),
    );
  });

  it("rejects cross-tenant shipment references without mutation", async () => {
    seedEvent(
      wire(ShippingWireEventType.TRACKING_UPDATED, "in_transit"),
      ShippingWireEventType.TRACKING_UPDATED,
    );
    prisma.shipment.findFirst.mockResolvedValue({
      id: "shipment-x",
      tenantId: "tenant-2",
      storeId: "store-x",
      fulfillmentId: "fulfillment-x",
      status: ShipmentStatus.CREATED,
      externalShipmentId: "ext-1",
      cancellationRequestedAt: null,
    });

    await service.processEvent("event-1");

    expect(fulfillmentService.shipShipment).not.toHaveBeenCalled();
    expect(prisma.shippingEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rejectionReason: expect.stringContaining("different tenant"),
        }),
      }),
    );
  });

  it("rejects unknown event types and contract versions", async () => {
    seedEvent(
      wire("shipping.made.up" as ShippingWireEventType, "in_transit"),
      "shipping.made.up",
    );
    seedShipment();

    await service.processEvent("event-1");

    expect(prisma.shippingEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rejectionReason: expect.stringContaining("Unknown shipping event type"),
        }),
      }),
    );

    vi.clearAllMocks();
    prisma.runAsSystem.mockImplementation(async (fn: () => unknown) => fn());
    prisma.runAsTenant.mockImplementation(
      async (_tenantId: string, fn: () => unknown) => fn(),
    );

    seedEvent(
      wire(ShippingWireEventType.TRACKING_UPDATED, "in_transit", {
        contractVersion: "99.0",
      }),
      ShippingWireEventType.TRACKING_UPDATED,
    );
    seedShipment();

    await service.processEvent("event-1");

    expect(prisma.shippingEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rejectionReason: expect.stringContaining("Unsupported shipping contract version"),
        }),
      }),
    );
  });

  it("quarantines malformed payloads before any mutation", async () => {
    seedEvent(
      { type: "shipping.tracking.updated", externalEventId: "se-1" },
      ShippingWireEventType.TRACKING_UPDATED,
    );
    seedShipment();

    await service.processEvent("event-1");

    expect(fulfillmentService.shipShipment).not.toHaveBeenCalled();
    expect(prisma.shippingEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rejectionReason: expect.stringContaining("missing externalShipmentId"),
        }),
      }),
    );
  });

  // ============================================================
  // Retries / dead-letter / claim semantics
  // ============================================================

  it("records retriable failures and dead-letters at the attempt limit", async () => {
    seedEvent(
      wire(ShippingWireEventType.TRACKING_UPDATED, "in_transit"),
      ShippingWireEventType.TRACKING_UPDATED,
    );
    seedShipment();
    fulfillmentService.shipShipment.mockRejectedValueOnce(
      new Error("inventory unavailable"),
    );

    await expect(
      service.processEvent("event-1", { attempt: 1, maxAttempts: 5 }),
    ).rejects.toThrow("inventory unavailable");

    expect(prisma.shippingEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: WebhookStatus.FAILED,
          lastError: "inventory unavailable",
        }),
      }),
    );

    vi.clearAllMocks();
    prisma.runAsSystem.mockImplementation(async (fn: () => unknown) => fn());
    prisma.runAsTenant.mockImplementation(
      async (_tenantId: string, fn: () => unknown) => fn(),
    );
    auditService.recordEvent.mockResolvedValue({});

    seedEvent(
      wire(ShippingWireEventType.TRACKING_UPDATED, "in_transit", {
        externalEventId: "se-9",
      }),
      ShippingWireEventType.TRACKING_UPDATED,
    );
    seedShipment();
    fulfillmentService.shipShipment.mockRejectedValueOnce(
      new Error("inventory unavailable"),
    );

    await expect(
      service.processEvent("event-1", { attempt: 5, maxAttempts: 5 }),
    ).rejects.toThrow("inventory unavailable");

    expect(prisma.shippingEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: WebhookStatus.DEAD_LETTER }),
      }),
    );
  });

  it("never re-processes events that were already claimed", async () => {
    prisma.shippingEvent.updateMany.mockResolvedValue({ count: 0 });

    const result = await service.processEvent("event-1");

    expect(result).toBeUndefined();
    expect(prisma.shippingEvent.findUnique).not.toHaveBeenCalled();
    expect(fulfillmentService.shipShipment).not.toHaveBeenCalled();
  });

  it("ignores events whose connection is no longer active", async () => {
    seedEvent(
      wire(ShippingWireEventType.TRACKING_UPDATED, "in_transit"),
      ShippingWireEventType.TRACKING_UPDATED,
    );
    prisma.shippingConnection.findUnique.mockResolvedValue({
      id: "connection-1",
      tenantId: "tenant-1",
      status: "DISCONNECTED",
    });

    await service.processEvent("event-1");

    expect(fulfillmentService.shipShipment).not.toHaveBeenCalled();
    expect(prisma.shippingEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rejectionReason: expect.stringContaining("DISCONNECTED"),
        }),
      }),
    );
  });

  it("exports the rejection error type used for quarantines", () => {
    const error = new ShippingEventRejectionError("reason");
    expect(error.name).toBe("ShippingEventRejectionError");
    expect(error.message).toBe("reason");
  });
});

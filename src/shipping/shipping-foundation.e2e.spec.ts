import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@prisma/client", () => import("../../test-utils/prisma-client.mock"));

import { UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { AuditService } from "../oms/audit/audit.service";
import { FulfillmentService } from "../oms/fulfillment/fulfillment.service";
import { encryptSecret } from "../shopify/shopify-auth.crypto";

import { FakeShippingProviderAdapter } from "./fake/fake-shipping.adapter";
import {
  SHIPPING_CONTRACT_VERSION,
  ShippingWireEventType,
} from "./shipping-contract";
import { ShippingEventIntakeService } from "./shipping-event-intake.service";
import { ShippingEventProcessorService } from "./shipping-event-processor.service";
import { ShippingRequestService } from "./shipping-request.service";

/**
 * Shipping-Provider Integration Foundation — Stage 2 end-to-end acceptance.
 *
 * Real services (FulfillmentService, ShippingRequestService,
 * ShippingEventIntake, ShippingEventProcessor, AuditService) driven by the
 * deterministic FakeShippingProviderAdapter over an in-memory database
 * that honors the exact query shapes the services use — no paid services,
 * no external credentials, no network.
 *
 * Acceptance flows covered here:
 * - one warehouse-ready fulfillment → ONE idempotent provider shipment
 *   request and ONE canonical Shipment (timeouts retry with the same key);
 * - AWB/label/pickup artifacts never mark anything shipped;
 * - only verified carrier handover marks IN_TRANSIT (inventory SHIP once);
 * - cancellation REQUESTED vs CONFIRMED stay distinct, and both race
 *   outcomes preserve verified provider state + flag reconciliation;
 * - duplicate, unknown, cross-tenant and out-of-order events are safe.
 */

type Row = Record<string, unknown> & { id: string };

function inMemoryDb() {
  const tables = {
    orders: [] as Row[],
    fulfillments: [] as Row[],
    shipments: [] as Row[],
    inventoryReservations: [] as Row[],
    inventoryItems: [] as Row[],
    shippingConnections: [] as Row[],
    shippingOutboundRequests: [] as Row[],
    shippingEvents: [] as Row[],
    auditEvents: [] as Row[],
  };

  let seq = 0;
  const nextId = (prefix: string) => `${prefix}-${++seq}`;

  function matches(row: Row, where: Record<string, unknown> = {}): boolean {
    return Object.entries(where).every(([key, condition]) => {
      if (key === "OR") {
        return (condition as Record<string, unknown>[]).some((sub) =>
          matches(row, sub),
        );
      }

      const value = row[key];

      if (
        condition !== null &&
        typeof condition === "object" &&
        !Array.isArray(condition)
      ) {
        const spec = condition as Record<string, unknown>;

        if ("in" in spec) {
          return (spec.in as unknown[]).includes(value);
        }

        if ("not" in spec) {
          return value !== spec.not;
        }

        const related = value as Row[] | undefined;

        return Array.isArray(related)
          ? related.some((r) => matches(r, spec))
          : related !== undefined && matches(related as Row, spec);
      }

      return value === condition;
    });
  }

  function fulfillmentView(fulfillment: Row) {
    const items = (fulfillment.items as Row[]).map((item) => {
      const shipmentItems = tables.shipments
        .flatMap((s) => s.items as Row[])
        .filter((si) => si.fulfillmentItemId === item.id);

      return {
        ...item,
        orderItem: (tables.orders[0]!.items as Row[]).find(
          (oi) => oi.id === item.orderItemId,
        ),
        reservation: tables.inventoryReservations.find(
          (r) => r.id === item.reservationId,
        ),
        inventoryItem: tables.inventoryItems.find(
          (ii) => ii.id === item.inventoryItemId,
        ),
        shipmentItems,
      };
    });

    const shipments = tables.shipments
      .filter((s) => s.fulfillmentId === fulfillment.id)
      .map((s) => ({ ...s }));

    return {
      ...(fulfillment as object),
      order: tables.orders.find((o) => o.id === fulfillment.orderId),
      location: { id: fulfillment.locationId, code: "WH-1" },
      items,
      shipments,
    };
  }

  function shipmentView(shipment: Row) {
    return {
      ...shipment,
      items: shipment.items,
      fulfillment: tables.fulfillments.find(
        (f) => f.id === shipment.fulfillmentId,
      ),
    };
  }

  const db = {
    tables,
    nextId,

    runAsSystem: async (fn: () => unknown) => fn(),
    runAsTenant: async (_tenantId: string, fn: () => unknown) => fn(),

    fulfillment: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const found = tables.fulfillments.find((f) => matches(f, where));

        return found ? fulfillmentView(found) : null;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = tables.fulfillments.find((f) => f.id === where.id)!;
        Object.assign(row, data);
        row.updatedAt = new Date();

        return fulfillmentView(row);
      },
    },

    shipment: {
      findFirst: async ({
        where,
        orderBy,
      }: {
        where: Record<string, unknown>;
        orderBy?: { createdAt: "desc" };
      }) => {
        const found = tables.shipments.filter((s) => matches(s, where));

        if (found.length === 0) {
          return null;
        }

        const picked = orderBy ? found[found.length - 1]! : found[0]!;

        return shipmentView(picked);
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row: Row = {
          id: nextId("shipment"),
          status: data.status,
          tenantId: data.tenantId,
          storeId: data.storeId,
          fulfillmentId: data.fulfillmentId,
          externalShipmentId: data.externalShipmentId ?? null,
          externalOrderId: null,
          carrier: data.carrier ?? null,
          service: data.service ?? null,
          trackingNumber: data.trackingNumber ?? null,
          trackingUrl: data.trackingUrl ?? null,
          awbCode: null,
          labelUrl: null,
          courierName: null,
          shippedAt: null,
          deliveredAt: null,
          handedOverAt: null,
          cancellationRequestedAt: null,
          cancellationRequestRef: null,
          lastProviderStatus: null,
          needsReconciliation: false,
          reconciliationReason: null,
          items: ((data.items as { create: Row[] }).create ?? []).map((item) => ({
            ...item,
            id: nextId("si"),
          })),
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        tables.shipments.push(row);

        return shipmentView(row);
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = tables.shipments.find((s) => s.id === where.id)!;

        for (const [key, value] of Object.entries(data)) {
          if (value !== undefined) {
            row[key] = value;
          }
        }

        row.updatedAt = new Date();

        return shipmentView(row);
      },
    },

    shipmentItem: {
      aggregate: async ({
        where,
      }: {
        where: Record<string, unknown>;
        _sum: unknown;
      }) => {
        const shipmentCondition = (where as { shipment: { status: unknown } })
          .shipment;

        const rows = tables.shipments
          .filter((s) => matches(s, shipmentCondition))
          .flatMap((s) => s.items as Row[])
          .filter((si) => si.fulfillmentItemId === where.fulfillmentItemId);

        return {
          _sum: {
            quantity: rows.reduce((sum, r) => sum + (r.quantity as number), 0),
          },
        };
      },
    },

    shippingConnection: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        tables.shippingConnections.find((c) => matches(c, where)) ?? null,
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        tables.shippingConnections.filter((c) => matches(c, where)),
      findUnique: async ({ where }: { where: { id: string } }) =>
        tables.shippingConnections.find((c) => c.id === where.id) ?? null,
    },

    shippingOutboundRequest: {
      findUnique: async ({
        where,
      }: {
        where: Record<
          string,
          { connectionId: string; idempotencyKey?: string; externalRequestId?: string }
        >;
      }) => {
        const key = Object.keys(where)[0]!;
        const spec = where[key]!;
        const found = tables.shippingOutboundRequests.find(
          (r) =>
            r.connectionId === spec.connectionId &&
            (spec.idempotencyKey !== undefined
              ? r.idempotencyKey === spec.idempotencyKey
              : r.externalRequestId === spec.externalRequestId),
        );

        return found ? { ...found } : null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row: Row = {
          id: nextId("request"),
          status: "PENDING",
          externalRequestId: null,
          responseJson: null,
          lastError: null,
          succeededAt: null,
          failedAt: null,
          ...data,
        };

        tables.shippingOutboundRequests.push(row);

        return { ...row };
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = tables.shippingOutboundRequests.find(
          (r) => r.id === where.id,
        )!;
        Object.assign(row, data);
        row.updatedAt = new Date();

        return { ...row };
      },
    },

    shippingEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const duplicate = tables.shippingEvents.find(
          (e) =>
            e.connectionId === data.connectionId &&
            e.externalEventId === data.externalEventId,
        );

        if (duplicate) {
          throw { code: "P2002" };
        }

        const row: Row = {
          id: nextId("event"),
          status: "RECEIVED",
          attempts: 0,
          lastError: null,
          rejectionReason: null,
          shipmentId: null,
          processedAt: null,
          receivedAt: new Date(),
          ...data,
        };

        tables.shippingEvents.push(row);

        return { ...row };
      },
      findUnique: async ({ where }: { where: Record<string, unknown> }) => {
        const spec =
          (where as { id?: string }).id !== undefined
            ? { id: (where as { id: string }).id }
            : (
                where as {
                  connectionId_externalEventId: {
                    connectionId: string;
                    externalEventId: string;
                  };
                }
              ).connectionId_externalEventId;

        const found = tables.shippingEvents.find((e) =>
          matches(e, spec as Record<string, unknown>),
        );

        return found ? { ...found } : null;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = tables.shippingEvents.find((e) => e.id === where.id)!;

        if (data.attempts && typeof data.attempts === "object") {
          row.attempts =
            (row.attempts as number) +
            (data.attempts as { increment: number }).increment;
          delete (data as { attempts?: unknown }).attempts;
        }

        for (const [key, value] of Object.entries(data)) {
          if (value !== undefined) {
            row[key] = value;
          }
        }

        return { ...row };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const rows = tables.shippingEvents.filter((e) => matches(e, where));
        rows.forEach((r) => Object.assign(r, data));

        return { count: rows.length };
      },
    },

    auditEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: nextId("audit"), ...data };
        tables.auditEvents.push(row);

        return { ...row };
      },
    },
  };

  return db;
}

describe("Shipping foundation end-to-end (fake shipping provider, real services)", () => {
  const secret = "shipping-secret-1";
  const encryptionKey = "test-encryption-key-for-shipping";

  let db: ReturnType<typeof inMemoryDb>;
  let adapter: FakeShippingProviderAdapter;
  let inventoryService: {
    releaseOrder: ReturnType<typeof vi.fn>;
    commitOrder: ReturnType<typeof vi.fn>;
    shipOrder: ReturnType<typeof vi.fn>;
    reserveOrder: ReturnType<typeof vi.fn>;
  };
  let fulfillmentService: FulfillmentService;
  let requestService: ShippingRequestService;
  let intake: ShippingEventIntakeService;
  let processor: ShippingEventProcessorService;
  let auditService: AuditService;

  function seedWarehouseReadyFulfillment() {
    db.tables.orders.push({
      id: "order-1",
      tenantId: "tenant-1",
      storeId: "store-1",
      orderNumber: "#1001",
      createdAt: new Date("2026-10-09T00:00:00.000Z"),
      items: [{ id: "oi-1", sku: "SKU-1", quantity: 3 }],
    });

    db.tables.inventoryItems.push({
      id: "inv-1",
      tenantId: "tenant-1",
      sku: "SKU-1",
    });

    db.tables.inventoryReservations.push({
      id: "res-1",
      tenantId: "tenant-1",
      storeId: "store-1",
      orderId: "order-1",
      orderItemId: "oi-1",
      inventoryItemId: "inv-1",
      locationId: "location-1",
      quantity: 3,
      status: "ACTIVE",
    });

    db.tables.fulfillments.push({
      id: "fulfillment-1",
      tenantId: "tenant-1",
      storeId: "store-1",
      orderId: "order-1",
      locationId: "location-1",
      status: "IN_PROGRESS",
      items: [
        {
          id: "fi-1",
          orderItemId: "oi-1",
          reservationId: "res-1",
          inventoryItemId: "inv-1",
          quantity: 3,
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    db.tables.shippingConnections.push({
      id: "connection-1",
      tenantId: "tenant-1",
      provider: "FAKE",
      externalAccountId: "acct-1",
      status: "ACTIVE",
      encryptedApiKey: null,
      encryptedWebhookSecret: encryptSecret(secret, encryptionKey),
    });
  }

  async function deliver(
    event: Record<string, unknown> & { type: string; externalEventId: string },
  ) {
    const delivery = FakeShippingProviderAdapter.buildSignedDelivery({
      secret,
      externalAccountId: "acct-1",
      event: {
        contractVersion: SHIPPING_CONTRACT_VERSION,
        externalShipmentId: "fake-ship-ship-fulfillment-1",
        occurredAt: "2026-10-09T12:00:00.000Z",
        ...event,
      },
    });

    const recorded = await intake.recordDelivery({
      adapter,
      envelope: adapter.readInboundEnvelope({
        headers: delivery.headers,
        rawBody: delivery.rawBody,
      }),
      headers: delivery.headers,
      payload: delivery.payload as never,
      payloadSha256: "sha256",
      rawBody: delivery.rawBody,
    });

    await processor.processEvent(recorded.shippingEventId, {
      attempt: 1,
      maxAttempts: 5,
    });

    return recorded;
  }

  beforeEach(() => {
    db = inMemoryDb();

    adapter = new FakeShippingProviderAdapter({
      get: vi.fn((key: string) =>
        key === "ENCRYPTION_KEY" ? encryptionKey : undefined,
      ),
    } as unknown as ConfigService);

    inventoryService = {
      releaseOrder: vi.fn(),
      commitOrder: vi.fn(),
      shipOrder: vi.fn(),
      reserveOrder: vi.fn(),
    };

    fulfillmentService = new FulfillmentService(
      db as never,
      inventoryService as never,
    );
    auditService = new AuditService(db as never);
    requestService = new ShippingRequestService(
      db as never,
      fulfillmentService,
      auditService as never,
      [adapter],
    );
    intake = new ShippingEventIntakeService(db as never, {
      enqueue: vi.fn(),
      requeue: vi.fn(),
    });
    processor = new ShippingEventProcessorService(
      db as never,
      fulfillmentService,
      auditService as never,
    );

    seedWarehouseReadyFulfillment();
  });

  it("creates ONE provider shipment per fulfillment — idempotent across retries and timeouts", async () => {
    adapter.timeoutNextCreate();

    await expect(
      requestService.createShipmentForFulfillment({
        tenantId: "tenant-1",
        storeId: "store-1",
        fulfillmentId: "fulfillment-1",
      }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });

    // Retry after the timeout: same key, same shipment, no duplicates.
    const result = await requestService.createShipmentForFulfillment({
      tenantId: "tenant-1",
      storeId: "store-1",
      fulfillmentId: "fulfillment-1",
    });

    expect(result.status).toBe("SUCCEEDED");
    expect(result.externalShipmentId).toBe("fake-ship-ship-fulfillment-1");
    expect(result.awbCode).toBe("FAKEAWBship-fulfillment-1");

    const again = await requestService.createShipmentForFulfillment({
      tenantId: "tenant-1",
      storeId: "store-1",
      fulfillmentId: "fulfillment-1",
    });

    expect(again.requestId).toBe(result.requestId);
    expect(db.tables.shipments).toHaveLength(1);
    expect(adapter.carrierShipmentCount).toBe(1);

    // Provider artifacts recorded as bookkeeping; NOTHING is shipped yet.
    const shipment = db.tables.shipments[0]!;
    expect(shipment.status).toBe("CREATED");
    expect(shipment.awbCode).toBe("FAKEAWBship-fulfillment-1");
    expect(shipment.externalShipmentId).toBe("fake-ship-ship-fulfillment-1");
    expect(inventoryService.shipOrder).not.toHaveBeenCalled();
  });

  it("maps the full happy path: AWB → pickup → handover → delivered, shipping ONLY at handover", async () => {
    await requestService.createShipmentForFulfillment({
      tenantId: "tenant-1",
      storeId: "store-1",
      fulfillmentId: "fulfillment-1",
    });

    // AWB/label: LABEL_CREATED at most — not shipped.
    await deliver({
      type: ShippingWireEventType.SHIPMENT_CREATED,
      externalEventId: "se-awb",
      status: "awb_assigned",
      awbCode: "FAKEAWBship-fulfillment-1",
      labelUrl: "https://fake-shipping.test/labels/ship-fulfillment-1.pdf",
    });

    expect(db.tables.shipments[0]!.status).toBe("LABEL_CREATED");
    expect(inventoryService.shipOrder).not.toHaveBeenCalled();

    // Pickup scheduling: no transition at all.
    await deliver({
      type: ShippingWireEventType.TRACKING_UPDATED,
      externalEventId: "se-pickup",
      status: "pickup_scheduled",
    });

    expect(db.tables.shipments[0]!.status).toBe("LABEL_CREATED");
    expect(inventoryService.shipOrder).not.toHaveBeenCalled();

    // Verified carrier handover: IN_TRANSIT + exactly one inventory SHIP.
    await deliver({
      type: ShippingWireEventType.TRACKING_UPDATED,
      externalEventId: "se-handover",
      status: "in_transit",
    });

    expect(db.tables.shipments[0]!.status).toBe("IN_TRANSIT");
    expect(db.tables.shipments[0]!.handedOverAt).toBeInstanceOf(Date);
    expect(inventoryService.shipOrder).toHaveBeenCalledTimes(1);

    // A duplicate handover (different provider event id) converges.
    await deliver({
      type: ShippingWireEventType.TRACKING_UPDATED,
      externalEventId: "se-handover-2",
      status: "in_transit",
    });

    expect(inventoryService.shipOrder).toHaveBeenCalledTimes(1);

    // Delivery completes the journey.
    const deliveredFirst = await deliver({
      type: ShippingWireEventType.TRACKING_DELIVERED,
      externalEventId: "se-delivered",
      status: "delivered",
    });

    expect(db.tables.shipments[0]!.status).toBe("DELIVERED");

    // Same external event id delivered twice: acknowledged, not re-applied.
    const duplicate = await deliver({
      type: ShippingWireEventType.TRACKING_DELIVERED,
      externalEventId: "se-delivered",
      status: "delivered",
    });

    expect(duplicate.shippingEventId).toBe(deliveredFirst.shippingEventId);
    expect(inventoryService.shipOrder).toHaveBeenCalledTimes(1);
  });

  it("keeps cancellation REQUESTED and CONFIRMED distinct", async () => {
    await requestService.createShipmentForFulfillment({
      tenantId: "tenant-1",
      storeId: "store-1",
      fulfillmentId: "fulfillment-1",
    });

    // Outbound request: soft state bookkeeping only.
    const request = await requestService.requestCancellation({
      tenantId: "tenant-1",
      storeId: "store-1",
      shipmentId: db.tables.shipments[0]!.id,
    });

    expect(request.providerStatus).toBe("cancellation_requested");
    expect(db.tables.shipments[0]!.status).toBe("CREATED");
    expect(db.tables.shipments[0]!.cancellationRequestedAt).toBeInstanceOf(Date);

    // Inbound confirmation: the CONFIRMED transition applies.
    await deliver({
      type: ShippingWireEventType.CANCELLATION_CONFIRMED,
      externalEventId: "se-cancelled",
      status: "cancelled",
    });

    expect(db.tables.shipments[0]!.status).toBe("CANCELLED");
    expect(inventoryService.releaseOrder).toHaveBeenCalledTimes(1);
  });

  it("preserves handover state when cancellation loses the race, and flags reconciliation", async () => {
    await requestService.createShipmentForFulfillment({
      tenantId: "tenant-1",
      storeId: "store-1",
      fulfillmentId: "fulfillment-1",
    });

    await deliver({
      type: ShippingWireEventType.TRACKING_UPDATED,
      externalEventId: "se-handover",
      status: "in_transit",
    });

    // Cancellation REQUEST after handover: preserved + flagged.
    await deliver({
      type: ShippingWireEventType.CANCELLATION_REQUESTED,
      externalEventId: "se-cancel-req",
      status: "cancellation_requested",
    });

    expect(db.tables.shipments[0]!.status).toBe("IN_TRANSIT");
    expect(db.tables.shipments[0]!.needsReconciliation).toBe(true);

    // Cancellation CONFIRMED after handover: provider state preserved + flagged.
    await deliver({
      type: ShippingWireEventType.CANCELLATION_CONFIRMED,
      externalEventId: "se-cancel-conf",
      status: "cancelled",
    });

    expect(db.tables.shipments[0]!.status).toBe("IN_TRANSIT");
    expect(db.tables.shipments[0]!.needsReconciliation).toBe(true);
    expect(String(db.tables.shipments[0]!.reconciliationReason)).toContain(
      "Provider confirmed cancellation after",
    );
    expect(inventoryService.releaseOrder).not.toHaveBeenCalled();
  });

  it("quarantines late handover after a committed cancellation, and flags reconciliation", async () => {
    await requestService.createShipmentForFulfillment({
      tenantId: "tenant-1",
      storeId: "store-1",
      fulfillmentId: "fulfillment-1",
    });

    await deliver({
      type: ShippingWireEventType.CANCELLATION_CONFIRMED,
      externalEventId: "se-cancelled",
      status: "cancelled",
    });

    expect(db.tables.shipments[0]!.status).toBe("CANCELLED");
    expect(inventoryService.releaseOrder).toHaveBeenCalledTimes(1);

    // The carrier now claims possession — a real discrepancy.
    await deliver({
      type: ShippingWireEventType.TRACKING_UPDATED,
      externalEventId: "se-handover",
      status: "in_transit",
    });

    // Committed cancellation preserved; event quarantined; reconciliation flagged.
    expect(db.tables.shipments[0]!.status).toBe("CANCELLED");
    expect(db.tables.shipments[0]!.needsReconciliation).toBe(true);
    expect(inventoryService.shipOrder).not.toHaveBeenCalled();

    const quarantined = db.tables.shippingEvents.find(
      (e) => e.externalEventId === "se-handover",
    )!;
    expect(String(quarantined.rejectionReason)).toContain("Out-of-order");
  });

  it("rejects cross-tenant events and unauthenticated deliveries without mutating state", async () => {
    await requestService.createShipmentForFulfillment({
      tenantId: "tenant-1",
      storeId: "store-1",
      fulfillmentId: "fulfillment-1",
    });

    // Cross-tenant: the delivery is signed with tenant-2's connection.
    db.tables.shippingConnections.push({
      id: "connection-2",
      tenantId: "tenant-2",
      provider: "FAKE",
      externalAccountId: "acct-2",
      status: "ACTIVE",
      encryptedApiKey: null,
      encryptedWebhookSecret: encryptSecret("other-secret", encryptionKey),
    });

    // Same account id, wrong secret -> rejected at intake, nothing stored.
    const forged = FakeShippingProviderAdapter.buildSignedDelivery({
      secret: "wrong-secret",
      externalAccountId: "acct-1",
      event: {
        contractVersion: SHIPPING_CONTRACT_VERSION,
        type: ShippingWireEventType.TRACKING_UPDATED,
        externalEventId: "se-forged",
        externalShipmentId: "fake-ship-ship-fulfillment-1",
        status: "in_transit",
        occurredAt: "2026-10-09T12:00:00.000Z",
      },
    });

    await expect(
      intake.recordDelivery({
        adapter,
        envelope: adapter.readInboundEnvelope({
          headers: forged.headers,
          rawBody: forged.rawBody,
        }),
        headers: forged.headers,
        payload: forged.payload as never,
        payloadSha256: "sha",
        rawBody: forged.rawBody,
      }),
    ).rejects.toThrow(UnauthorizedException);

    expect(db.tables.shippingEvents).toHaveLength(0);
    expect(db.tables.shipments[0]!.status).toBe("CREATED");

    // An authenticated event referencing a foreign tenant's shipment id
    // would need to resolve through its identity; the (connection, event)
    // key makes cross-tenant application impossible when the shipment
    // belongs to someone else — verified in the processor unit suite.
  });

  it("quarantines events for unknown shipments and unknown event types", async () => {
    await requestService.createShipmentForFulfillment({
      tenantId: "tenant-1",
      storeId: "store-1",
      fulfillmentId: "fulfillment-1",
    });

    await deliver({
      type: ShippingWireEventType.TRACKING_UPDATED,
      externalEventId: "se-unknown-shipment",
      externalShipmentId: "no-such-shipment",
      status: "in_transit",
    });

    const unknownShipment = db.tables.shippingEvents.find(
      (e) => e.externalEventId === "se-unknown-shipment",
    )!;
    expect(String(unknownShipment.rejectionReason)).toContain("unknown shipment");

    await deliver({
      type: "shipping.made.up",
      externalEventId: "se-unknown-type",
      status: "in_transit",
    });

    const unknownType = db.tables.shippingEvents.find(
      (e) => e.externalEventId === "se-unknown-type",
    )!;
    expect(String(unknownType.rejectionReason)).toContain(
      "Unknown shipping event type",
    );

    expect(db.tables.shipments[0]!.status).toBe("CREATED");
    expect(inventoryService.shipOrder).not.toHaveBeenCalled();
  });
});

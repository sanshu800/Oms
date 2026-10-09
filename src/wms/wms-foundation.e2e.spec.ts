import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@prisma/client", () => import("../../test-utils/prisma-client.mock"));

import { StoreConnectionStatus, WmsProvider, WmsRequestStatus } from "@prisma/client";

import { AuditService } from "../oms/audit/audit.service";
import { FulfillmentService } from "../oms/fulfillment/fulfillment.service";
import { encryptSecret } from "../shopify/shopify-auth.crypto";
import { FakeWmsAdapter } from "./fake/fake-wms.adapter";
import { WMS_EVENT_TYPES } from "./wms-contract";
import { WmsEventIntakeService } from "./wms-event-intake.service";
import { WmsEventProcessorService } from "./wms-event-processor.service";
import { WmsRequestService } from "./wms-request.service";

/**
 * WMS Integration Foundation — Stage 1 end-to-end acceptance.
 *
 * Real services (FulfillmentService, WmsRequestService, WmsEventIntake,
 * WmsEventProcessor, AuditService) driven by the deterministic FakeWmsAdapter
 * over an in-memory database that honors the exact query shapes the
 * services use — no paid services, no external credentials, no network.
 *
 * Acceptance flows covered here:
 * - one reserved order → one IDEMPOTENT fulfillment request through the
 *   contract (retries/duplicates never create a second warehouse request);
 * - the fake WMS acknowledges and sends warehouse events that update
 *   canonical fulfillment/shipment state correctly (partial quantities);
 * - duplicate, invalid and out-of-order events are safely handled;
 * - failure/retry paths converge instead of duplicating work.
 */

type Row = Record<string, unknown> & { id: string };

function inMemoryDb() {
  const tables = {
    orders: [] as Row[],
    fulfillments: [] as Row[],
    shipments: [] as Row[],
    inventoryReservations: [] as Row[],
    inventoryItems: [] as Row[],
    wmsConnections: [] as Row[],
    wmsRequests: [] as Row[],
    wmsRequestLines: [] as Row[],
    wmsEvents: [] as Row[],
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

        // Nested relation filter (e.g. shipment: { status: { in } }).
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

  const db = {
    tables,
    nextId,

    $transaction: async (fn: (tx: unknown) => unknown) => fn(db),

    runAsSystem: async (fn: () => unknown) => fn(),
    runAsTenant: async (_tenantId: string, fn: () => unknown) => fn(),

    order: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const order = tables.orders.find((o) => matches(o, where));

        if (!order) {
          return null;
        }

        const reservationsWhere =
          ((where.include as Record<string, unknown> | undefined)?.reservations as
            | { where?: Record<string, unknown> }
            | undefined)?.where ?? {};

        return {
          ...order,
          items: order.items,
          reservations: tables.inventoryReservations.filter(
            (r) => r.orderId === order.id && matches(r, reservationsWhere),
          ),
        };
      },
    },

    inventoryReservation: {
      findMany: async ({
        where,
      }: {
        where: Record<string, unknown>;
        select?: unknown;
        distinct?: unknown;
      }) => {
        const all = tables.inventoryReservations.filter((r) =>
          matches(r, where),
        );

        const seen = new Set<string>();
        const distinct = all.filter((r) => {
          const key = String(r.locationId);

          if (seen.has(key)) {
            return false;
          }
          seen.add(key);
          return true;
        });

        return distinct;
      },
    },

    fulfillment: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const found = tables.fulfillments.find((f) => matches(f, where));

        return found ? fulfillmentView(found) : null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row: Row = {
          id: nextId("fulfillment"),
          status: data.status,
          tenantId: data.tenantId,
          storeId: data.storeId,
          orderId: data.orderId,
          locationId: data.locationId,
          items: ((data.items as { create: Row[] }).create ?? []).map((item) => ({
            ...item,
            id: nextId("fi"),
          })),
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        tables.fulfillments.push(row);

        return fulfillmentView(row);
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
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const found = tables.shipments.find((s) => matches(s, where));

        return found
          ? {
              ...found,
              items: found.items,
              fulfillment: tables.fulfillments.find(
                (f) => f.id === found.fulfillmentId,
              ),
            }
          : null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row: Row = {
          id: nextId("shipment"),
          status: data.status,
          tenantId: data.tenantId,
          storeId: data.storeId,
          fulfillmentId: data.fulfillmentId,
          externalShipmentId: data.externalShipmentId,
          carrier: data.carrier ?? null,
          service: data.service ?? null,
          trackingNumber: data.trackingNumber ?? null,
          trackingUrl: data.trackingUrl ?? null,
          shippedAt: null,
          deliveredAt: null,
          items: ((data.items as { create: Row[] }).create ?? []).map((item) => ({
            ...item,
            id: nextId("si"),
          })),
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        tables.shipments.push(row);

        return {
          ...row,
          items: row.items,
          fulfillment: tables.fulfillments.find(
            (f) => f.id === row.fulfillmentId,
          ),
        };
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = tables.shipments.find((s) => s.id === where.id)!;
        Object.assign(row, data);
        row.updatedAt = new Date();

        return {
          ...row,
          items: row.items,
          fulfillment: tables.fulfillments.find(
            (f) => f.id === row.fulfillmentId,
          ),
        };
      },
    },

    shipmentItem: {
      aggregate: async ({
        where,
      }: {
        where: Record<string, unknown>;
        _sum: unknown;
      }) => {
        const rows = tables.shipments
          .filter((s) => matches(s, { status: (where as { shipment: { status: unknown } }).shipment.status }))
          .flatMap((s) => s.items as Row[])
          .filter((si) => si.fulfillmentItemId === where.fulfillmentItemId);

        return {
          _sum: {
            quantity: rows.reduce((sum, r) => sum + (r.quantity as number), 0),
          },
        };
      },
      findMany: async ({
        where,
      }: {
        where: Record<string, unknown>;
        select?: unknown;
      }) => {
        const shipmentCondition = (where as { shipment: { status: unknown } })
          .shipment;
        const fulfillmentId = (
          where as { fulfillmentItem: { fulfillmentId: string } }
        ).fulfillmentItem.fulfillmentId;

        return tables.shipments
          .filter((s) => matches(s, shipmentCondition))
          .flatMap((s) => s.items as Row[])
          .filter((si) => {
            const fi = tables.fulfillments
              .flatMap((f) => f.items as Row[])
              .find((item) => item.id === si.fulfillmentItemId);

            return fi && tables.fulfillments.find((f) => (f.items as Row[]).includes(fi))?.id === fulfillmentId;
          })
          .map((si) => ({
            fulfillmentItemId: si.fulfillmentItemId,
            quantity: si.quantity,
          }));
      },
    },

    wmsConnection: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        tables.wmsConnections.find((c) => matches(c, where)) ?? null,
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        tables.wmsConnections.filter((c) => matches(c, where)),
      findUnique: async ({ where }: { where: { id: string } }) =>
        tables.wmsConnections.find((c) => c.id === where.id) ?? null,
    },

    wmsFulfillmentRequest: {
      findUnique: async ({
        where,
      }: {
        where: Record<string, { connectionId: string; idempotencyKey?: string; externalRequestId?: string }>;
      }) => {
        const key = Object.keys(where)[0]!;
        const spec = where[key]!;
        const found = tables.wmsRequests.find(
          (r) =>
            r.connectionId === spec.connectionId &&
            (spec.idempotencyKey !== undefined
              ? r.idempotencyKey === spec.idempotencyKey
              : r.externalRequestId === spec.externalRequestId),
        );

        return found
          ? {
              ...found,
              lines: tables.wmsRequestLines.filter(
                (l) => l.requestId === found.id,
              ),
            }
          : null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row: Row = {
          id: nextId("request"),
          ...data,
        };
        delete (row as { lines?: unknown }).lines;

        const lineRows = ((data as { lines: { create: Row[] } }).lines?.create ?? []).map(
          (line) => ({
            pickedQuantity: 0,
            packedQuantity: 0,
            shippedQuantity: 0,
            ...line,
            id: nextId("rl"),
            requestId: row.id,
          }),
        );

        tables.wmsRequests.push(row);
        tables.wmsRequestLines.push(...lineRows);

        return { ...row, lines: lineRows };
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = tables.wmsRequests.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        row.updatedAt = new Date();

        return { ...row };
      },
    },

    wmsFulfillmentRequestLine: {
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = tables.wmsRequestLines.find((l) => l.id === where.id)!;
        Object.assign(row, data);
        row.updatedAt = new Date();

        return { ...row };
      },
    },

    wmsEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const duplicate = tables.wmsEvents.find(
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
          requestId: null,
          processedAt: null,
          receivedAt: new Date(),
          ...data,
        };

        tables.wmsEvents.push(row);

        return { ...row };
      },
      findUnique: async ({
        where,
      }: {
        where: Record<string, unknown>;
      }) => {
        const spec =
          (where as { id?: string }).id !== undefined
            ? { id: (where as { id: string }).id }
            : (where as { connectionId_externalEventId: { connectionId: string; externalEventId: string } })
                .connectionId_externalEventId;

        const found = tables.wmsEvents.find((e) => matches(e, spec as Record<string, unknown>));

        return found ? { ...found } : null;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = tables.wmsEvents.find((e) => e.id === where.id)!;

        if (data.attempts && typeof data.attempts === "object") {
          row.attempts = (row.attempts as number) + ((data.attempts as { increment: number }).increment);
          delete (data as { attempts?: unknown }).attempts;
        }

        Object.assign(row, data);

        return { ...row };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const rows = tables.wmsEvents.filter((e) => matches(e, where));
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

describe("WMS foundation end-to-end (fake WMS, real services)", () => {
  const secret = "wms-secret-1";
  const encryptionKey = "test-encryption-key-for-wms-secrets";

  let db: ReturnType<typeof inMemoryDb>;
  let adapter: FakeWmsAdapter;
  let inventoryService: {
    releaseOrder: ReturnType<typeof vi.fn>;
    commitOrder: ReturnType<typeof vi.fn>;
    shipOrder: ReturnType<typeof vi.fn>;
    reserveOrder: ReturnType<typeof vi.fn>;
  };
  let fulfillmentService: FulfillmentService;
  let requestService: WmsRequestService;
  let intake: WmsEventIntakeService;
  let processor: WmsEventProcessorService;
  let auditService: AuditService;

  function seedReservedOrder() {
    db.tables.orders.push({
      id: "order-1",
      tenantId: "tenant-1",
      storeId: "store-1",
      orderNumber: "#1001",
      items: [
        { id: "oi-1", sku: "SKU-1", quantity: 3 },
        { id: "oi-2", sku: "SKU-2", quantity: 2 },
      ],
    });

    db.tables.inventoryItems.push(
      { id: "inv-1", tenantId: "tenant-1", sku: "SKU-1" },
      { id: "inv-2", tenantId: "tenant-1", sku: "SKU-2" },
    );

    db.tables.inventoryReservations.push(
      {
        id: "res-1",
        tenantId: "tenant-1",
        storeId: "store-1",
        orderId: "order-1",
        orderItemId: "oi-1",
        inventoryItemId: "inv-1",
        locationId: "location-1",
        quantity: 3,
        status: "ACTIVE",
      },
      {
        id: "res-2",
        tenantId: "tenant-1",
        storeId: "store-1",
        orderId: "order-1",
        orderItemId: "oi-2",
        inventoryItemId: "inv-2",
        locationId: "location-1",
        quantity: 2,
        status: "ACTIVE",
      },
    );
  }

  async function deliver(event: {
    eventType: string;
    externalEventId: string;
    [key: string]: unknown;
  }) {
    const delivery = FakeWmsAdapter.buildSignedDelivery({
      secret,
      externalWarehouseId: "wh-1",
      event: {
        requestRef: "fulfillment-1",
        occurredAt: "2026-10-09T12:00:00.000Z",
        ...event,
      },
    });

    const recorded = await intake.recordDelivery({
      adapter,
      envelope: { externalWarehouseId: "wh-1", externalEventId: event.externalEventId },
      headers: delivery.headers,
      payload: delivery.payload as never,
      payloadSha256: "sha256",
      rawBody: delivery.rawBody,
    });

    await processor.processEvent(recorded.wmsEventId, {
      attempt: 1,
      maxAttempts: 5,
    });

    return recorded;
  }

  beforeEach(() => {
    db = inMemoryDb();

    adapter = new FakeWmsAdapter({
      get: vi.fn((key: string) =>
        key === "ENCRYPTION_KEY" ? encryptionKey : undefined,
      ),
    } as never);

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

    requestService = new WmsRequestService(
      db as never,
      fulfillmentService,
      auditService,
      [adapter],
    );

    intake = new WmsEventIntakeService(db as never, {
      enqueue: vi.fn(),
      requeue: vi.fn(),
    } as never);

    processor = new WmsEventProcessorService(
      db as never,
      fulfillmentService,
      auditService,
    );

    db.tables.wmsConnections.push({
      id: "connection-1",
      tenantId: "tenant-1",
      provider: WmsProvider.FAKE,
      externalWarehouseId: "wh-1",
      locationId: "location-1",
      status: StoreConnectionStatus.ACTIVE,
      encryptedApiKey: null,
      encryptedWebhookSecret: encryptSecret(secret, encryptionKey),
    });

    seedReservedOrder();
  });

  it("acceptance: one reserved order generates ONE idempotent fulfillment request, and the fake WMS drives canonical state end to end", async () => {
    // 1. Reserved order → fulfillment execution unit(s).
    const fulfillments = await fulfillmentService.createForOrder({
      tenantId: "tenant-1",
      storeId: "store-1",
      orderId: "order-1",
    });

    expect(fulfillments).toHaveLength(1);
    expect(fulfillments[0]!.status).toBe("READY");
    expect(fulfillments[0]!.items).toHaveLength(2);

    // 2. Submit through the contract — twice (operator double-click, or a
    //    worker retry after a timeout).
    const first = await requestService.submitFulfillmentRequest({
      tenantId: "tenant-1",
      storeId: "store-1",
      fulfillmentId: fulfillments[0]!.id,
    });

    // Make the fulfillment's id the stable correlation key used below.
    db.tables.wmsRequests[0]!.fulfillmentId = fulfillments[0]!.id;
    db.tables.wmsRequests[0]!.idempotencyKey = fulfillments[0]!.id;

    const second = await requestService.submitFulfillmentRequest({
      tenantId: "tenant-1",
      storeId: "store-1",
      fulfillmentId: fulfillments[0]!.id,
    });

    expect(second.requestId).toBe(first.requestId);
    expect(first.status).toBe(WmsRequestStatus.SUBMITTED);
    expect(adapter.warehouseRequestCount).toBe(1);
    expect(db.tables.wmsRequests).toHaveLength(1);
    expect(db.tables.wmsRequestLines).toHaveLength(2);

    // 3. The warehouse acknowledges; execution starts.
    await deliver({
      eventType: WMS_EVENT_TYPES.ACKNOWLEDGED,
      externalEventId: "wms-ev-ack-1",
      requestRef: fulfillments[0]!.id,
      externalRequestId: first.externalRequestId!,
    });

    expect(
      db.tables.fulfillments.find((f) => f.id === fulfillments[0]!.id)!.status,
    ).toBe("IN_PROGRESS");
    expect(db.tables.wmsRequests[0]!.status).toBe(WmsRequestStatus.ACKNOWLEDGED);

    // 4. Pick/pack progress — cumulative quantities, no shipment yet.
    await deliver({
      eventType: WMS_EVENT_TYPES.PICKED,
      externalEventId: "wms-ev-pick-1",
      requestRef: fulfillments[0]!.id,
      lines: [
        { externalLineRef: "oi-1", quantity: 3 },
        { externalLineRef: "oi-2", quantity: 2 },
      ],
    });

    await deliver({
      eventType: WMS_EVENT_TYPES.PACKED,
      externalEventId: "wms-ev-pack-1",
      requestRef: fulfillments[0]!.id,
      lines: [
        { externalLineRef: "oi-1", quantity: 3 },
        { externalLineRef: "oi-2", quantity: 2 },
      ],
    });

    expect(db.tables.wmsRequestLines.map((l) => [l.pickedQuantity, l.packedQuantity])).toEqual([
      [3, 3],
      [2, 2],
    ]);
    expect(db.tables.shipments).toHaveLength(0);

    // 5. Partial handover (2 of the 3 units on line 1) → PARTIALLY_FULFILLED.
    await deliver({
      eventType: WMS_EVENT_TYPES.SHIPPED,
      externalEventId: "wms-ev-ship-1",
      requestRef: fulfillments[0]!.id,
      lines: [{ externalLineRef: "oi-1", quantity: 2 }],
      shipment: {
        externalShipmentId: "wms-shipment-1",
        carrier: "FAKE-LOGISTICS",
        trackingNumber: "FAKE-AWB-1",
      },
    });

    expect(db.tables.shipments[0]!.status).toBe("IN_TRANSIT");
    expect(
      db.tables.fulfillments.find((f) => f.id === fulfillments[0]!.id)!.status,
    ).toBe("PARTIALLY_FULFILLED");
    expect(db.tables.wmsRequests[0]!.status).toBe(WmsRequestStatus.ACKNOWLEDGED);
    expect(inventoryService.shipOrder).toHaveBeenCalledTimes(1);

    // 6. Duplicate delivery of the same event — acknowledged, NOT re-applied.
    await deliver({
      eventType: WMS_EVENT_TYPES.SHIPPED,
      externalEventId: "wms-ev-ship-1",
      requestRef: fulfillments[0]!.id,
      lines: [{ externalLineRef: "oi-1", quantity: 2 }],
      shipment: {
        externalShipmentId: "wms-shipment-1",
        carrier: "FAKE-LOGISTICS",
        trackingNumber: "FAKE-AWB-1",
      },
    });

    expect(db.tables.shipments).toHaveLength(1);
    expect(inventoryService.shipOrder).toHaveBeenCalledTimes(1);
    expect(
      db.tables.wmsRequestLines.map((l) => l.shippedQuantity),
    ).toEqual([2, 0]);

    // 7. Final handover (the rest) → FULFILLED, request COMPLETED, inventory
    //    committed. A label/AWB is data on the handover — the handover is
    //    what moves state.
    await deliver({
      eventType: WMS_EVENT_TYPES.SHIPPED,
      externalEventId: "wms-ev-ship-2",
      requestRef: fulfillments[0]!.id,
      lines: [
        { externalLineRef: "oi-1", quantity: 1 },
        { externalLineRef: "oi-2", quantity: 2 },
      ],
      shipment: {
        externalShipmentId: "wms-shipment-2",
        trackingNumber: "FAKE-AWB-2",
      },
    });

    expect(
      db.tables.fulfillments.find((f) => f.id === fulfillments[0]!.id)!.status,
    ).toBe("FULFILLED");
    expect(db.tables.wmsRequests[0]!.status).toBe(WmsRequestStatus.COMPLETED);
    expect(inventoryService.commitOrder).toHaveBeenCalledTimes(1);

    // 8. Everything is auditable.
    const actions = db.tables.auditEvents.map((e) => e.action);
    expect(actions).toContain("WMS_FULFILLMENT_REQUEST_SUBMITTED");
    expect(actions).toContain("WMS_EVENT_APPLIED");

    // 9. An over-shipment after completion is rejected, not applied.
    await deliver({
      eventType: WMS_EVENT_TYPES.SHIPPED,
      externalEventId: "wms-ev-ship-3",
      requestRef: fulfillments[0]!.id,
      lines: [{ externalLineRef: "oi-2", quantity: 1 }],
      shipment: { externalShipmentId: "wms-shipment-3" },
    });

    expect(db.tables.shipments).toHaveLength(2);

    const lateEvent = db.tables.wmsEvents.find(
      (e) => e.externalEventId === "wms-ev-ship-3",
    )!;
    expect(lateEvent.rejectionReason).toContain("Illegal warehouse transition");
  });

  it("acceptance: failure/retry paths converge — no duplicate requests or shipments", async () => {
    const fulfillments = await fulfillmentService.createForOrder({
      tenantId: "tenant-1",
      storeId: "store-1",
      orderId: "order-1",
    });

    // Submit fails at the adapter (timeout-equivalent).
    adapter.failNextSubmit("warehouse unavailable");

    await expect(
      requestService.submitFulfillmentRequest({
        tenantId: "tenant-1",
        storeId: "store-1",
        fulfillmentId: fulfillments[0]!.id,
      }),
    ).rejects.toThrow("warehouse unavailable");

    expect(db.tables.wmsRequests[0]!.status).toBe(WmsRequestStatus.FAILED);
    expect(db.tables.wmsRequests[0]!.lastError).toBe("warehouse unavailable");
    expect(adapter.warehouseRequestCount).toBe(0);

    // Retry with the same idempotency key: ONE warehouse request exists.
    await requestService.submitFulfillmentRequest({
      tenantId: "tenant-1",
      storeId: "store-1",
      fulfillmentId: fulfillments[0]!.id,
    });

    expect(adapter.warehouseRequestCount).toBe(1);
    expect(db.tables.wmsRequests[0]!.status).toBe(WmsRequestStatus.SUBMITTED);

    // The warehouse reports it cannot execute → canonical FAILED and the
    // reserved inventory is released.
    await deliver({
      eventType: WMS_EVENT_TYPES.FAILED,
      externalEventId: "wms-ev-fail-1",
      requestRef: fulfillments[0]!.id,
      failureReason: "stock discrepancy",
    });

    expect(
      db.tables.fulfillments.find((f) => f.id === fulfillments[0]!.id)!.status,
    ).toBe("FAILED");
    expect(db.tables.wmsRequests[0]!.status).toBe(WmsRequestStatus.FAILED);
    expect(db.tables.wmsRequests[0]!.lastError).toBe("stock discrepancy");
    expect(inventoryService.releaseOrder).toHaveBeenCalledTimes(1);

    // A late pick event after failure is an illegal regression — rejected.
    await deliver({
      eventType: WMS_EVENT_TYPES.PICKED,
      externalEventId: "wms-ev-pick-late",
      requestRef: fulfillments[0]!.id,
      lines: [{ externalLineRef: "oi-1", quantity: 1 }],
    });

    const lateEvent = db.tables.wmsEvents.find(
      (e) => e.externalEventId === "wms-ev-pick-late",
    )!;
    expect(lateEvent.rejectionReason).toContain("Illegal warehouse transition");
    expect(
      db.tables.wmsRequestLines.find((l) => l.externalLineRef === "oi-1")!
        .pickedQuantity,
    ).toBe(0);
  });

  it("acceptance: out-of-order and unknown events never corrupt state", async () => {
    const fulfillments = await fulfillmentService.createForOrder({
      tenantId: "tenant-1",
      storeId: "store-1",
      orderId: "order-1",
    });

    await requestService.submitFulfillmentRequest({
      tenantId: "tenant-1",
      storeId: "store-1",
      fulfillmentId: fulfillments[0]!.id,
    });

    // Handover BEFORE acknowledgement: rejected, nothing created.
    await deliver({
      eventType: WMS_EVENT_TYPES.SHIPPED,
      externalEventId: "wms-ev-early",
      requestRef: fulfillments[0]!.id,
      lines: [{ externalLineRef: "oi-1", quantity: 1 }],
      shipment: { externalShipmentId: "wms-shipment-x" },
    });

    expect(db.tables.shipments).toHaveLength(0);
    expect(
      db.tables.wmsEvents.find((e) => e.externalEventId === "wms-ev-early")!
        .rejectionReason,
    ).toContain("Illegal warehouse transition");

    // Unknown warehouse status (e.g. shipping-provider vocabulary leaking
    // into the warehouse stream): rejected and recorded, never applied.
    await deliver({
      eventType: "shipment.awb_assigned",
      externalEventId: "wms-ev-label",
      requestRef: fulfillments[0]!.id,
    });

    expect(
      db.tables.wmsEvents.find((e) => e.externalEventId === "wms-ev-label")!
        .rejectionReason,
    ).toContain("Unknown WMS event type");

    // A delivery referencing a request this warehouse never received:
    // rejected (also the cross-tenant boundary — foreign refs do not apply).
    await deliver({
      eventType: WMS_EVENT_TYPES.ACKNOWLEDGED,
      externalEventId: "wms-ev-foreign",
      requestRef: "someone-elses-request",
    });

    expect(
      db.tables.wmsEvents.find((e) => e.externalEventId === "wms-ev-foreign")!
        .rejectionReason,
    ).toContain("unknown request");

    // The real flow still works after all that noise.
    await deliver({
      eventType: WMS_EVENT_TYPES.ACKNOWLEDGED,
      externalEventId: "wms-ev-ack-ok",
      requestRef: fulfillments[0]!.id,
    });

    expect(
      db.tables.fulfillments.find((f) => f.id === fulfillments[0]!.id)!.status,
    ).toBe("IN_PROGRESS");
    expect(db.tables.shipments).toHaveLength(0);
    expect(inventoryService.releaseOrder).not.toHaveBeenCalled();
    expect(inventoryService.commitOrder).not.toHaveBeenCalled();
  });
});

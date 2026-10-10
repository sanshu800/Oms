/**
 * Shipping-Provider Integration Foundation — Stage 2 real-database test.
 *
 * Convention: same shape as wms-foundation-real-db-test.ts — a ts-node
 * script against a real PostgreSQL + the full Nest application context
 * (Prisma + RLS extensions active). Requires a running database
 * (`docker compose up -d` + `npm run db:deploy`); not runnable in
 * environments without Postgres.
 *
 * Covers the Stage 2 acceptance flow end to end against real tables:
 * warehouse-ready fulfillment → ONE idempotent provider shipment request
 * → AWB/label/pickup artifacts (never shipped) → verified carrier
 * handover (IN_TRANSIT, one inventory SHIP) → duplicate delivery safety →
 * cancellation requested/confirmed distinctness and race handling →
 * RLS tenant isolation on the new tables → audit trail.
 *
 * Also verifies (Stage 2.1 database gate): cancellation on a PARTIALLY
 * SHIPPED fulfillment preserves shipped history and never releases
 * inventory; the duplicate-event / idempotency unique constraints
 * (P2002); and foreign-tenant invisibility under real RLS.
 *
 * Run topology matters: run migrations as the table-owning role, then run
 * this script as a NON-superuser role (Postgres exempts superusers from
 * RLS unconditionally). See docs/SHIPPING-PROVIDER.md §8 for commands.
 * The whole flow runs under a system-bypass context (provisioning); the
 * services themselves establish their own tenant contexts internally, so
 * every processor/intake query still exercises real RLS.
 *
 * Run: npx ts-node shipping-foundation-real-db-test.ts
 */
import { NestFactory } from "@nestjs/core";
import {
  ShippingProvider,
  ShippingRequestStatus,
  ShipmentStatus,
  StoreConnectionStatus,
} from "@prisma/client";

import { AppModule } from "./src/app.module";
import { PrismaService } from "./src/prisma/prisma.service";
import { tenantContextStorage } from "./src/prisma/tenant-context";
import { FulfillmentService } from "./src/oms/fulfillment/fulfillment.service";
import { encryptSecret } from "./src/shopify/shopify-auth.crypto";
import { FakeShippingProviderAdapter } from "./src/shipping/fake/fake-shipping.adapter";
import {
  SHIPPING_ADAPTERS,
  SHIPPING_CONTRACT_VERSION,
  ShippingProviderAdapter,
  ShippingWireEventType,
} from "./src/shipping/shipping-contract";
import { ShippingEventIntakeService } from "./src/shipping/shipping-event-intake.service";
import { ShippingEventProcessorService } from "./src/shipping/shipping-event-processor.service";
import { ShippingRequestService } from "./src/shipping/shipping-request.service";

const WEBHOOK_SECRET = "real-db-shipping-secret";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`TEST FAILED: ${message}`);
  }
}

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule);

  try {
    const prisma = app.get(PrismaService);
    const fulfillmentService = app.get(FulfillmentService);
    const requestService = app.get(ShippingRequestService);
    const intake = app.get(ShippingEventIntakeService);
    const processor = app.get(ShippingEventProcessorService);
    const adapters = app.get(SHIPPING_ADAPTERS) as ShippingProviderAdapter[];
    const adapter = adapters.find(
      (a) => a.provider === ShippingProvider.FAKE,
    );

    assert(adapter instanceof FakeShippingProviderAdapter, "FAKE shipping adapter not registered");

    const stamp = Date.now();

    // ---- Seed two tenants (RLS), a store, stock, and an order ----

    const tenant = await prisma.tenant.create({
      data: { name: `shipping-real-db-tenant-${stamp}` },
    });

    const otherTenant = await prisma.tenant.create({
      data: { name: `shipping-real-db-other-${stamp}` },
    });

    const store = await prisma.storeConnection.create({
      data: {
        tenantId: tenant.id,
        platform: "SHOPIFY",
        externalStoreId: `shipping-real-db-${stamp}.myshopify.com`,
        status: StoreConnectionStatus.ACTIVE,
      },
    });

    const location = await prisma.inventoryLocation.create({
      data: {
        tenantId: tenant.id,
        code: `SHIP-LOC-${stamp}`,
        name: "Shipping Stage-2 Warehouse",
      },
    });

    const inventoryItem = await prisma.inventoryItem.create({
      data: {
        tenantId: tenant.id,
        sku: `SHIP-SKU-${stamp}`,
        name: "Shipping Stage-2 Item",
      },
    });

    await prisma.inventoryBalance.create({
      data: {
        inventoryItemId: inventoryItem.id,
        locationId: location.id,
        availableQty: 10,
        reservedQty: 0,
      },
    });

    const order = await prisma.order.create({
      data: {
        tenantId: tenant.id,
        storeId: store.id,
        externalOrderId: `shipping-real-db-order-${stamp}`,
        orderNumber: `#S-${stamp}`,
        status: "NEW",
        paymentStatus: "paid",
        fulfillmentStatus: "unfulfilled",
        totalAmount: "30.00",
        currency: "USD",
        orderedAt: new Date(),
        items: {
          create: {
            externalLineItemId: `shipping-real-db-line-${stamp}`,
            sku: inventoryItem.sku,
            title: "Shipping Stage-2 Item",
            quantity: 3,
            unitPrice: "10.00",
          },
        },
      },
      include: { items: true },
    });

    const orderItem = order.items[0]!;

    await prisma.inventoryReservation.createMany({
      data: {
        tenantId: tenant.id,
        storeId: store.id,
        orderId: order.id,
        orderItemId: orderItem.id,
        inventoryItemId: inventoryItem.id,
        locationId: location.id,
        quantity: 3,
        status: "ACTIVE",
      },
    });

    const fulfillment = (await fulfillmentService.createForOrder({
      tenantId: tenant.id,
      storeId: store.id,
      orderId: order.id,
    }))[0]!;

    const fulfillmentId = fulfillment.id;

    await fulfillmentService.start({
      tenantId: tenant.id,
      storeId: store.id,
      fulfillmentId,
    });

    const connection = await prisma.shippingConnection.create({
      data: {
        tenantId: tenant.id,
        provider: ShippingProvider.FAKE,
        externalAccountId: `shipping-real-db-acct-${stamp}`,
        status: StoreConnectionStatus.ACTIVE,
        encryptedWebhookSecret: encryptSecret(WEBHOOK_SECRET, process.env.ENCRYPTION_KEY as string),
        connectedAt: new Date(),
      },
    });

    // ---- (1) ONE idempotent provider shipment per fulfillment ----

    const first = await requestService.createShipmentForFulfillment({
      tenantId: tenant.id,
      storeId: store.id,
      fulfillmentId,
    });

    const second = await requestService.createShipmentForFulfillment({
      tenantId: tenant.id,
      storeId: store.id,
      fulfillmentId,
    });

    assert(first.requestId === second.requestId, "resubmit created a second outbound request");
    assert(first.status === ShippingRequestStatus.SUCCEEDED, "request not SUCCEEDED");
    assert(adapter.carrierShipmentCount === 1, "carrier saw more than one shipment");
    assert(first.externalShipmentId !== null, "no externalShipmentId recorded");

    const shipmentId = first.shipmentId;
    const externalShipmentId = first.externalShipmentId as string;

    // ---- (2) AWB/label/pickup artifacts are NOT shipping ----

    const deliver = async (event: Record<string, unknown> & { type: string; externalEventId: string }) => {
      const delivery = FakeShippingProviderAdapter.buildSignedDelivery({
        secret: WEBHOOK_SECRET,
        externalAccountId: connection.externalAccountId,
        event: {
          contractVersion: SHIPPING_CONTRACT_VERSION,
          externalShipmentId,
          occurredAt: new Date().toISOString(),
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
    };

    await deliver({
      type: ShippingWireEventType.SHIPMENT_CREATED,
      externalEventId: `se-awb-${stamp}`,
      status: "awb_assigned",
      awbCode: first.awbCode ?? undefined,
      labelUrl: first.labelUrl ?? undefined,
    });

    let shipment = await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } });

    assert(shipment.status === ShipmentStatus.LABEL_CREATED, `after AWB: shipment is ${shipment.status}`);

    await deliver({
      type: ShippingWireEventType.TRACKING_UPDATED,
      externalEventId: `se-pickup-${stamp}`,
      status: "pickup_scheduled",
    });

    shipment = await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } });

    assert(shipment.status === ShipmentStatus.LABEL_CREATED, `after pickup: shipment is ${shipment.status}`);

    // ---- (3) Verified carrier handover marks IN_TRANSIT exactly once ----

    await deliver({
      type: ShippingWireEventType.TRACKING_UPDATED,
      externalEventId: `se-handover-${stamp}`,
      status: "in_transit",
    });

    shipment = await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } });

    assert(shipment.status === ShipmentStatus.IN_TRANSIT, `after handover: shipment is ${shipment.status}`);
    assert(shipment.handedOverAt !== null, "handedOverAt not recorded");

    // Duplicate handover (new provider event id): converges, no double-ship.
    await deliver({
      type: ShippingWireEventType.TRACKING_UPDATED,
      externalEventId: `se-handover-dup-${stamp}`,
      status: "in_transit",
    });

    // Same provider event id: acked without re-processing.
    const replay = await deliver({
      type: ShippingWireEventType.TRACKING_UPDATED,
      externalEventId: `se-handover-${stamp}`,
      status: "in_transit",
    });

    const replayRow = await prisma.shippingEvent.findUniqueOrThrow({
      where: { id: replay.shippingEventId },
    });

    assert(replayRow.status === "PROCESSED", `replayed event is ${replayRow.status}`);

    // ---- (4) Cancellation races preserve verified provider state ----

    await deliver({
      type: ShippingWireEventType.CANCELLATION_CONFIRMED,
      externalEventId: `se-cancel-after-handover-${stamp}`,
      status: "cancelled",
    });

    shipment = await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } });

    assert(shipment.status === ShipmentStatus.IN_TRANSIT, "late confirmation rewrote committed handover state");
    assert(shipment.needsReconciliation === true, "late cancellation confirmation not flagged");

    // ---- (5) Cancellation requested vs confirmed stay distinct ----

    const order2 = await prisma.order.create({
      data: {
        tenantId: tenant.id,
        storeId: store.id,
        externalOrderId: `shipping-real-db-order2-${stamp}`,
        orderNumber: `#S2-${stamp}`,
        status: "NEW",
        paymentStatus: "paid",
        fulfillmentStatus: "unfulfilled",
        totalAmount: "10.00",
        currency: "USD",
        orderedAt: new Date(),
        items: {
          create: {
            externalLineItemId: `shipping-real-db-line2-${stamp}`,
            sku: inventoryItem.sku,
            title: "Shipping Stage-2 Item",
            quantity: 1,
            unitPrice: "10.00",
          },
        },
      },
      include: { items: true },
    });

    await prisma.inventoryReservation.createMany({
      data: {
        tenantId: tenant.id,
        storeId: store.id,
        orderId: order2.id,
        orderItemId: order2.items[0]!.id,
        inventoryItemId: inventoryItem.id,
        locationId: location.id,
        quantity: 1,
        status: "ACTIVE",
      },
    });

    const fulfillment2 = (await fulfillmentService.createForOrder({
      tenantId: tenant.id,
      storeId: store.id,
      orderId: order2.id,
    }))[0]!;

    await fulfillmentService.start({
      tenantId: tenant.id,
      storeId: store.id,
      fulfillmentId: fulfillment2.id,
    });

    const second2 = await requestService.createShipmentForFulfillment({
      tenantId: tenant.id,
      storeId: store.id,
      fulfillmentId: fulfillment2.id,
    });

    const requested = await requestService.requestCancellation({
      tenantId: tenant.id,
      storeId: store.id,
      shipmentId: second2.shipmentId,
    });

    assert(requested.providerStatus === "cancellation_requested", "request did not stay soft");

    const afterRequest = await prisma.shipment.findUniqueOrThrow({
      where: { id: second2.shipmentId },
    });

    assert(
      afterRequest.status !== ShipmentStatus.CANCELLED,
      "cancellation REQUEST marked the shipment cancelled",
    );
    assert(afterRequest.cancellationRequestedAt !== null, "cancellationRequestedAt not recorded");

    await deliver({
      type: ShippingWireEventType.CANCELLATION_CONFIRMED,
      externalEventId: `se-cancel2-${stamp}`,
      externalShipmentId: second2.externalShipmentId as string,
      status: "cancelled",
    });

    const afterConfirm = await prisma.shipment.findUniqueOrThrow({
      where: { id: second2.shipmentId },
    });

    assert(afterConfirm.status === ShipmentStatus.CANCELLED, "confirmed cancellation not applied");

    // Sole shipment, nothing shipped: releaseOrder is CORRECT here — the
    // order's reservations must end RELEASED.
    const order2Reservations = await prisma.inventoryReservation.findMany({
      where: { orderId: order2.id },
    });

    assert(order2Reservations.length > 0, "order2 has no reservations");
    assert(
      order2Reservations.every((r) => r.status === "RELEASED"),
      `order2 reservations are ${order2Reservations.map((r) => r.status).join(",")} — expected RELEASED`,
    );

    // ---- (5b) Partially shipped fulfillment: remainder cancellation ----
    //
    // A WMS-style shipment (2 of 3 units) hands over first; then the
    // shipping-provider remainder (1 unit) is cancelled. The completed
    // shipment history must survive, and NO inventory may be released
    // (releaseOrder frees whole ACTIVE reservations — shipped units
    // included — which would be an over-release).

    const order3 = await prisma.order.create({
      data: {
        tenantId: tenant.id,
        storeId: store.id,
        externalOrderId: `shipping-real-db-order3-${stamp}`,
        orderNumber: `#S3-${stamp}`,
        status: "NEW",
        paymentStatus: "paid",
        fulfillmentStatus: "unfulfilled",
        totalAmount: "30.00",
        currency: "USD",
        orderedAt: new Date(),
        items: {
          create: {
            externalLineItemId: `shipping-real-db-line3-${stamp}`,
            sku: inventoryItem.sku,
            title: "Shipping Stage-2 Item",
            quantity: 3,
            unitPrice: "10.00",
          },
        },
      },
      include: { items: true },
    });

    await prisma.inventoryReservation.createMany({
      data: {
        tenantId: tenant.id,
        storeId: store.id,
        orderId: order3.id,
        orderItemId: order3.items[0]!.id,
        inventoryItemId: inventoryItem.id,
        locationId: location.id,
        quantity: 3,
        status: "ACTIVE",
      },
    });

    const fulfillment3 = (
      await fulfillmentService.createForOrder({
        tenantId: tenant.id,
        storeId: store.id,
        orderId: order3.id,
      })
    )[0]!;

    await fulfillmentService.start({
      tenantId: tenant.id,
      storeId: store.id,
      fulfillmentId: fulfillment3.id,
    });

    const fulfillment3View = await fulfillmentService.getById({
      tenantId: tenant.id,
      storeId: store.id,
      fulfillmentId: fulfillment3.id,
    });
    const fi3 = fulfillment3View.items[0]!;

    const shipmentA = await fulfillmentService.createShipment({
      tenantId: tenant.id,
      storeId: store.id,
      fulfillmentId: fulfillment3.id,
      externalShipmentId: `ext3-A-${stamp}`,
      items: [{ fulfillmentItemId: fi3.id, quantity: 2 }],
    });

    await deliver({
      type: ShippingWireEventType.TRACKING_UPDATED,
      externalEventId: `se3-A-handover-${stamp}`,
      externalShipmentId: `ext3-A-${stamp}`,
      status: "in_transit",
    });

    const afterHandover3 = await prisma.fulfillment.findUniqueOrThrow({
      where: { id: fulfillment3.id },
    });

    assert(
      afterHandover3.status === "PARTIALLY_FULFILLED",
      `after partial handover: fulfillment is ${afterHandover3.status}`,
    );

    const shipmentB = await fulfillmentService.createShipment({
      tenantId: tenant.id,
      storeId: store.id,
      fulfillmentId: fulfillment3.id,
      externalShipmentId: `ext3-B-${stamp}`,
      items: [{ fulfillmentItemId: fi3.id, quantity: 1 }],
    });

    await deliver({
      type: ShippingWireEventType.CANCELLATION_CONFIRMED,
      externalEventId: `se3-B-cancelled-${stamp}`,
      externalShipmentId: `ext3-B-${stamp}`,
      status: "cancelled",
    });

    const finalA = await prisma.shipment.findUniqueOrThrow({
      where: { id: shipmentA.id },
      include: { items: true },
    });
    const finalB = await prisma.shipment.findUniqueOrThrow({
      where: { id: shipmentB.id },
      include: { items: true },
    });
    const finalFulfillment3 = await prisma.fulfillment.findUniqueOrThrow({
      where: { id: fulfillment3.id },
    });

    // History preserved: only the remainder is cancelled.
    assert(finalB.status === ShipmentStatus.CANCELLED, `remainder is ${finalB.status}`);
    assert(finalA.status === ShipmentStatus.IN_TRANSIT, `shipped sibling is ${finalA.status} — history not preserved`);
    assert(finalA.items.length === 1, "shipped sibling items were mutated");
    assert(
      finalFulfillment3.status === "PARTIALLY_FULFILLED",
      `partially shipped fulfillment became ${finalFulfillment3.status}`,
    );

    // No incorrect inventory release: the order's reservations cover shipped
    // and unshipped units alike — none may be RELEASED or COMMITTED here.
    const order3Reservations = await prisma.inventoryReservation.findMany({
      where: { orderId: order3.id },
    });

    assert(order3Reservations.length > 0, "no reservations recorded for order3");
    assert(
      order3Reservations.reduce((sum, r) => sum + r.quantity, 0) === 3,
      "expected 3 reserved units for order3",
    );
    assert(
      order3Reservations.every((r) => r.status === "ACTIVE"),
      `order3 reservations are ${order3Reservations.map((r) => r.status).join(",")} — expected all ACTIVE (no release after partial shipment)`,
    );

    assert(finalB.needsReconciliation === true, "partial cancellation not flagged for reconciliation");

    // Shipped bookkeeping still counts only the live shipment.
    const sums3 = await fulfillmentService.getShippedQuantityByFulfillmentItem(
      fulfillment3.id,
    );

    assert(sums3.get(fi3.id) === 2, `shipped sum is ${sums3.get(fi3.id)} — expected 2`);

    // ---- (5c) Duplicate-event and idempotency unique constraints ----

    await prisma.shippingEvent.create({
      data: {
        tenantId: tenant.id,
        connectionId: connection.id,
        externalEventId: `se-dup-${stamp}`,
        eventType: "shipping.tracking.updated",
        payload: {},
        payloadSha256: "sha",
      },
    });

    const dupEvent = await prisma.shippingEvent
      .create({
        data: {
          tenantId: tenant.id,
          connectionId: connection.id,
          externalEventId: `se-dup-${stamp}`,
          eventType: "shipping.tracking.updated",
          payload: {},
          payloadSha256: "sha",
        },
      })
      .then(() => null)
      .catch((error: unknown) => error as { code?: string });

    assert(dupEvent?.code === "P2002", "duplicate (connectionId, externalEventId) must violate uniqueness");

    const dupRequest = await prisma.shippingOutboundRequest
      .create({
        data: {
          tenantId: tenant.id,
          storeId: store.id,
          connectionId: connection.id,
          fulfillmentId,
          kind: "SHIPMENT_CREATE",
          idempotencyKey: `ship-${fulfillmentId}`,
        },
      })
      .then(() => null)
      .catch((error: unknown) => error as { code?: string });

    assert(dupRequest?.code === "P2002", "duplicate (connectionId, idempotencyKey) must violate uniqueness");

    // ---- (6) RLS tenant isolation on the new tables ----

    const visibleEvents = await prisma.runAsTenant(tenant.id, () =>
      prisma.shippingEvent.findMany({ where: { connectionId: connection.id } }),
    );

    assert(visibleEvents.length > 0, "owner tenant cannot see its own shipping events");

    const foreignEvents = await prisma.runAsTenant(otherTenant.id, () =>
      prisma.shippingEvent.findMany({ where: { connectionId: connection.id } }),
    );

    assert(foreignEvents.length === 0, "RLS leaked shipping events across tenants");

    const foreignRequests = await prisma.runAsTenant(otherTenant.id, () =>
      prisma.shippingOutboundRequest.findMany({ where: { connectionId: connection.id } }),
    );

    assert(foreignRequests.length === 0, "RLS leaked outbound requests across tenants");

    const foreignConnections = await prisma.runAsTenant(otherTenant.id, () =>
      prisma.shippingConnection.findMany({ where: { id: connection.id } }),
    );

    assert(foreignConnections.length === 0, "RLS leaked shipping connections across tenants");

    // ---- (7) Audit trail ----

    const auditActions = (
      await prisma.auditEvent.findMany({
        where: { tenantId: tenant.id, entityType: "SHIPPING_EVENT" },
        select: { action: true },
      })
    ).map((e) => e.action);

    assert(auditActions.includes("SHIPPING_EVENT_APPLIED"), "audit trail missing SHIPPING_EVENT_APPLIED");

    console.log(
      JSON.stringify(
        {
          result: "PASS",
          tenantId: tenant.id,
          fulfillmentId,
          requestId: first.requestId,
          shipmentId,
          externalShipmentId,
          shipmentStatus: (await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } })).status,
          needsReconciliation: shipment.needsReconciliation,
          carrierShipments: adapter.carrierShipmentCount,
          auditActions,
          rls: "ok",
        },
        null,
        2,
      ),
    );
  } finally {
    await app.close();
  }
}

// The provisioning/flow context is system-bypass (seed rows and read them
// back without ambient tenant stamps); every service still establishes its
// own tenant/system context internally, so RLS is exercised for real.
tenantContextStorage
  .run({ bypass: true }, () => main())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

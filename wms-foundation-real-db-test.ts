/**
 * WMS Integration Foundation — Stage 1 real-database integration test.
 *
 * Convention: same shape as order-failure-exception-real-db-test.ts — a
 * ts-node script against a real PostgreSQL + the full Nest application
 * context (Prisma + RLS extensions active). Requires a running database
 * (`docker compose up -d` + `npm run db:deploy`); not runnable in
 * environments without Postgres.
 *
 * Covers the Stage 1 acceptance flow end to end against real tables:
 * reserved order → idempotent fulfillment request through the contract →
 * fake-WMS acknowledgement → pick/pack/ship events → canonical
 * fulfillment/shipment state → duplicate delivery safety → audit trail.
 *
 * Run: npx ts-node wms-foundation-real-db-test.ts
 */
import { NestFactory } from "@nestjs/core";
import { StoreConnectionStatus, WmsProvider, WmsRequestStatus } from "@prisma/client";

import { AppModule } from "./src/app.module";
import { PrismaService } from "./src/prisma/prisma.service";
import { FulfillmentService } from "./src/oms/fulfillment/fulfillment.service";
import { encryptSecret } from "./src/shopify/shopify-auth.crypto";
import { FakeWmsAdapter } from "./src/wms/fake/fake-wms.adapter";
import {
  WMS_ADAPTERS,
  WMS_EVENT_TYPES,
  WmsAdapter,
} from "./src/wms/wms-contract";
import { WmsEventIntakeService } from "./src/wms/wms-event-intake.service";
import { WmsEventProcessorService } from "./src/wms/wms-event-processor.service";
import { WmsRequestService } from "./src/wms/wms-request.service";

const WEBHOOK_SECRET = "real-db-wms-secret";

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
    const requestService = app.get(WmsRequestService);
    const intake = app.get(WmsEventIntakeService);
    const processor = app.get(WmsEventProcessorService);
    const adapters = app.get(WMS_ADAPTERS) as WmsAdapter[];
    const adapter = adapters.find((a) => a.provider === WmsProvider.FAKE);

    assert(adapter instanceof FakeWmsAdapter, "FAKE WMS adapter not registered");

    const stamp = Date.now();

    // ---- Seed a tenant, a store, stock, and a reserved order ----

    const tenant = await prisma.tenant.create({
      data: { name: `wms-real-db-tenant-${stamp}` },
    });

    const store = await prisma.storeConnection.create({
      data: {
        tenantId: tenant.id,
        platform: "SHOPIFY",
        externalStoreId: `wms-real-db-${stamp}.myshopify.com`,
        status: StoreConnectionStatus.ACTIVE,
      },
    });

    const location = await prisma.inventoryLocation.create({
      data: {
        tenantId: tenant.id,
        code: `WMS-REAL-${stamp}`,
        name: "Real DB WMS location",
      },
    });

    const inventoryItem = await prisma.inventoryItem.create({
      data: {
        tenantId: tenant.id,
        sku: `WMS-REAL-SKU-${stamp}`,
        name: "Real DB WMS item",
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
        externalOrderId: `wms-real-order-${stamp}`,
        orderNumber: `#WMS-REAL-${stamp}`,
        status: "NEW",
        paymentStatus: "paid",
        fulfillmentStatus: "unfulfilled",
        totalAmount: "59.90",
        currency: "USD",
        orderedAt: new Date(),
        items: {
          create: {
            externalLineItemId: `wms-real-line-${stamp}`,
            sku: inventoryItem.sku,
            title: "Real DB WMS item",
            quantity: 3,
            unitPrice: "19.95",
          },
        },
      },
      include: { items: true },
    });

    await prisma.inventoryReservation.createMany({
      data: {
        tenantId: tenant.id,
        storeId: store.id,
        orderId: order.id,
        orderItemId: order.items[0]!.id,
        inventoryItemId: inventoryItem.id,
        locationId: location.id,
        quantity: 3,
        status: "ACTIVE",
      },
    });

    // ---- WMS connection (credentials encrypted at rest) ----

    const connection = await prisma.wmsConnection.create({
      data: {
        tenantId: tenant.id,
        provider: WmsProvider.FAKE,
        externalWarehouseId: `wms-real-wh-${stamp}`,
        locationId: location.id,
        status: StoreConnectionStatus.ACTIVE,
        encryptedWebhookSecret: encryptSecret(
          WEBHOOK_SECRET,
          process.env.ENCRYPTION_KEY as string,
        ),
        connectedAt: new Date(),
      },
    });

    // ---- Reserved order → fulfillment → ONE idempotent request ----

    const fulfillments = await prisma.runAsTenant(tenant.id, () =>
      fulfillmentService.createForOrder({
        tenantId: tenant.id,
        storeId: store.id,
        orderId: order.id,
      }),
    );

    assert(fulfillments.length === 1, "expected exactly one fulfillment");
    const fulfillmentId = fulfillments[0]!.id;

    const first = await prisma.runAsTenant(tenant.id, () =>
      requestService.submitFulfillmentRequest({
        tenantId: tenant.id,
        storeId: store.id,
        fulfillmentId,
      }),
    );

    const second = await prisma.runAsTenant(tenant.id, () =>
      requestService.submitFulfillmentRequest({
        tenantId: tenant.id,
        storeId: store.id,
        fulfillmentId,
      }),
    );

    assert(first.requestId === second.requestId, "resubmit created a second request");
    assert(first.status === WmsRequestStatus.SUBMITTED, "request not SUBMITTED");
    assert(adapter.warehouseRequestCount === 1, "warehouse saw more than one request");

    // ---- Fake WMS events → canonical state ----

    const deliver = async (event: Record<string, unknown>) => {
      const delivery = FakeWmsAdapter.buildSignedDelivery({
        secret: WEBHOOK_SECRET,
        externalWarehouseId: connection.externalWarehouseId,
        event: {
          requestRef: fulfillmentId,
          occurredAt: new Date().toISOString(),
          ...event,
        },
      });

      const recorded = await prisma.runAsSystem(() =>
        intake.recordDelivery({
          adapter: adapter as FakeWmsAdapter,
          envelope: {
            externalWarehouseId: connection.externalWarehouseId,
            externalEventId: String(event.externalEventId),
          },
          headers: delivery.headers,
          payload: delivery.payload as never,
          payloadSha256: "sha256",
          rawBody: delivery.rawBody,
        }),
      );

      await processor.processEvent(recorded.wmsEventId, {
        attempt: 1,
        maxAttempts: 5,
      });
    };

    await deliver({
      eventType: WMS_EVENT_TYPES.ACKNOWLEDGED,
      externalEventId: `wms-real-ack-${stamp}`,
      externalRequestId: first.externalRequestId,
    });

    await deliver({
      eventType: WMS_EVENT_TYPES.PICKED,
      externalEventId: `wms-real-pick-${stamp}`,
      lines: [{ externalLineRef: order.items[0]!.id, quantity: 3 }],
    });

    await deliver({
      eventType: WMS_EVENT_TYPES.SHIPPED,
      externalEventId: `wms-real-ship-${stamp}`,
      lines: [{ externalLineRef: order.items[0]!.id, quantity: 3 }],
      shipment: {
        externalShipmentId: `wms-real-shipment-${stamp}`,
        trackingNumber: `FAKE-AWB-${stamp}`,
      },
    });

    // Duplicate delivery — acknowledged, not re-applied.
    await deliver({
      eventType: WMS_EVENT_TYPES.SHIPPED,
      externalEventId: `wms-real-ship-${stamp}`,
      lines: [{ externalLineRef: order.items[0]!.id, quantity: 3 }],
      shipment: {
        externalShipmentId: `wms-real-shipment-${stamp}`,
        trackingNumber: `FAKE-AWB-${stamp}`,
      },
    });

    const finalFulfillment = await prisma.fulfillment.findUniqueOrThrow({
      where: { id: fulfillmentId },
      include: { shipments: { include: { items: true } } },
    });

    const finalRequest = await prisma.wmsFulfillmentRequest.findUniqueOrThrow({
      where: { id: first.requestId },
      include: { lines: true },
    });

    assert(finalFulfillment.status === "FULFILLED", `fulfillment is ${finalFulfillment.status}`);
    assert(finalFulfillment.shipments.length === 1, "duplicate shipment created");
    assert(finalRequest.status === WmsRequestStatus.COMPLETED, `request is ${finalRequest.status}`);
    assert(finalRequest.lines[0]!.shippedQuantity === 3, "shipped bookkeeping drifted");

    const auditActions = (
      await prisma.auditEvent.findMany({
        where: { tenantId: tenant.id, entityType: "WMS_EVENT" },
        select: { action: true },
      })
    ).map((e) => e.action);

    assert(auditActions.includes("WMS_EVENT_APPLIED"), "audit trail missing WMS_EVENT_APPLIED");

    console.log(
      JSON.stringify(
        {
          result: "PASS",
          tenantId: tenant.id,
          fulfillmentId,
          requestId: first.requestId,
          externalRequestId: first.externalRequestId,
          fulfillmentStatus: finalFulfillment.status,
          requestStatus: finalRequest.status,
          shipments: finalFulfillment.shipments.length,
          auditActions,
        },
        null,
        2,
      ),
    );
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

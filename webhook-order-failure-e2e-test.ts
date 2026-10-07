import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import {
  FastifyAdapter,
  NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { createHash, createHmac } from "node:crypto";
import { verifyShopifyWebhook } from "./src/webhooks/shopify-signature";

import { AppModule } from "./src/app.module";
import { PrismaService } from "./src/prisma/prisma.service";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 15000,
  intervalMs = 250,
) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (await check()) {
      return true;
    }

    await sleep(intervalMs);
  }

  return false;
}

async function main() {
  const app =
    await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter({ logger: false }),
      { rawBody: true },
    );

  try {
    await app.init();

    const prisma = app.get(PrismaService);
    const config = app.get(ConfigService);
    const fastify = app.getHttpAdapter().getInstance();

    const store =
      await prisma.storeConnection.findUnique({
        where: {
          shopDomain: "techmart-lab.myshopify.com",
        },
        select: {
          id: true,
          tenantId: true,
          shopDomain: true,
        },
      });

    if (!store) {
      throw new Error(
        "Store techmart-lab.myshopify.com was not found.",
      );
    }

    const inventoryItem =
      await prisma.inventoryItem.findFirst({
        where: {
          tenantId: store.tenantId,
          sku: "sku-managed-1",
          active: true,
        },
        include: {
          balances: true,
        },
      });

    if (!inventoryItem) {
      throw new Error(
        "sku-managed-1 inventory item was not found.",
      );
    }

    const availableQty =
      inventoryItem.balances.reduce(
        (total, balance) =>
          total + balance.availableQty,
        0,
      );

    const requestedQty = availableQty + 1;

    const stamp = Date.now();

    const shopifyEventId =
      `techmart-e2e-event-${stamp}`;

    const externalOrderId =
      `techmart-e2e-order-${stamp}`;

    const orderNumber =
      `#E2E-${stamp}`;

    const lineItemId =
      `techmart-e2e-line-${stamp}`;

    const payload = {
      id: externalOrderId,
      name: orderNumber,
      financial_status: "paid",
      fulfillment_status: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      total_price: "629.95",
      currency: "USD",
      line_items: [
        {
          id: lineItemId,
          sku: inventoryItem.sku,
          title: inventoryItem.name,
          quantity: requestedQty,
          price: "629.95",
        },
      ],
    };

    const rawBody = Buffer.from(
      JSON.stringify(payload),
      "utf8",
    );

    const secret = config.getOrThrow<string>("SHOPIFY_WEBHOOK_SECRET");

    const signature =
      createHmac("sha256", secret)
        .update(rawBody)
        .digest("base64");

    console.log("LOCAL HMAC CHECK:", verifyShopifyWebhook(rawBody, signature, secret));
    console.log("SIGNED BODY SHA256:", createHash("sha256").update(rawBody).digest("hex"));
    console.log("SIGNED BODY LENGTH:", rawBody.length);

    console.log(
      JSON.stringify(
        {
          store: store.shopDomain,
          tenantId: store.tenantId,
          storeId: store.id,
          sku: inventoryItem.sku,
          availableQty,
          requestedQty,
          shortageQty:
            requestedQty - availableQty,
          shopifyEventId,
          externalOrderId,
          orderNumber,
        },
        null,
        2,
      ),
    );

    // --------------------------------------------------
    // 1. REAL HTTP WEBHOOK REQUEST
    // --------------------------------------------------

    const response =
      await fastify.inject({
        method: "POST",
        url: "/webhooks/shopify",
        headers: {
          "content-type": "application/json",
          "x-shopify-hmac-sha256":
            signature,
          "x-shopify-shop-domain":
            store.shopDomain,
          "x-shopify-webhook-id":
            shopifyEventId,
          "x-shopify-topic":
            "orders/create",
        },
        payload: rawBody.toString("utf8"),
      });

    console.log(
      `HTTP STATUS: ${response.statusCode}`,
    );

    console.log(
      `HTTP BODY: ${response.body}`,
    );

    if (response.statusCode !== 201) {
      throw new Error(
        `TEST FAILED: Expected webhook HTTP 201, got ${response.statusCode}`,
      );
    }

    // --------------------------------------------------
    // 2. WAIT FOR REAL QUEUE -> PROCESSOR -> ORDER
    // --------------------------------------------------

    const orderCreated =
      await waitFor(async () => {
        const order =
          await prisma.order.findUnique({
            where: {
              storeId_externalOrderId: {
                storeId: store.id,
                externalOrderId,
              },
            },
          });

        return !!order;
      });

    if (!orderCreated) {
      throw new Error(
        "TEST FAILED: Webhook was accepted but OMS order was never created.",
      );
    }

    const order =
      await prisma.order.findUnique({
        where: {
          storeId_externalOrderId: {
            storeId: store.id,
            externalOrderId,
          },
        },
        include: {
          items: true,
          reservations: true,
        },
      });

    if (!order) {
      throw new Error(
        "TEST FAILED: OMS order disappeared.",
      );
    }

    // --------------------------------------------------
    // 3. WAIT FOR OPERATIONAL EXCEPTION
    // --------------------------------------------------

    const exceptionCreated =
      await waitFor(async () => {
        const item = order.items[0];

        if (!item) {
          return false;
        }

        const fingerprint =
          `ORDER_INVENTORY_FAILURE:${order.id}:${item.id}`;

        const exception =
          await prisma.operationalException.findUnique({
            where: {
              storeId_fingerprint: {
                storeId: store.id,
                fingerprint,
              },
            },
          });

        return !!exception;
      });

    if (!exceptionCreated) {
      throw new Error(
        "TEST FAILED: Order was created but operational exception was not persisted.",
      );
    }

    const failedItem = order.items[0];

    if (!failedItem) {
      throw new Error(
        "TEST FAILED: Order has no line item.",
      );
    }

    const fingerprint =
      `ORDER_INVENTORY_FAILURE:${order.id}:${failedItem.id}`;

    const exception =
      await prisma.operationalException.findUnique({
        where: {
          storeId_fingerprint: {
            storeId: store.id,
            fingerprint,
          },
        },
      });

    const webhookEvent =
      await prisma.webhookEvent.findUnique({
        where: {
          storeId_shopifyEventId: {
            storeId: store.id,
            shopifyEventId,
          },
        },
      });

    if (!exception) {
      throw new Error(
        "TEST FAILED: No operational exception persisted before claim.",
      );
    }

    console.log(
      JSON.stringify(
        {
          webhook: {
            httpStatus: response.statusCode,
            eventId:
              webhookEvent?.id,
            status:
              webhookEvent?.status,
            attempts:
              webhookEvent?.attempts,
            lastError:
              webhookEvent?.lastError,
          },
          order: {
            id: order.id,
            orderNumber:
              order.orderNumber,
            status:
              order.status,
            sku:
              failedItem.sku,
            requestedQty:
              failedItem.quantity,
            reservations:
              order.reservations.length,
          },
          exception: exception
            ? {
                id: exception.id,
                status:
                  exception.status,
                category:
                  exception.category,
                severity:
                  exception.severity,
                fingerprint:
                  exception.fingerprint,
                evidence:
                  exception.evidence,
              }
            : null,
        },
        null,
        2,
      ),
    );

    // --------------------------------------------------
    // 4. REAL HTTP EXCEPTION CLAIM
    // --------------------------------------------------

    const claimResponse =
      await fastify.inject({
        method: "POST",
        url: `/oms/exceptions/${exception.id}/claim`,
        headers: {
          "content-type": "application/json",
        },
        payload: JSON.stringify({
          tenantId: store.tenantId,
          storeId: store.id,
          actorType: "USER",
          actorId: "e2e-operator",
        }),
      });

    console.log(`CLAIM HTTP STATUS: ${claimResponse.statusCode}`);
    console.log(`CLAIM HTTP BODY: ${claimResponse.body}`);

    if (claimResponse.statusCode !== 200) {
      throw new Error(
        `TEST FAILED: Expected claim HTTP 200, got ${claimResponse.statusCode}`,
      );
    }

    const claimedExceptionReady =
      await waitFor(async () => {
        const current =
          await prisma.operationalException.findUnique({
            where: {
              storeId_fingerprint: {
                storeId: store.id,
                fingerprint,
              },
            },
          });

        return current?.status === "INVESTIGATING";
      });

    if (!claimedExceptionReady) {
      throw new Error(
        "TEST FAILED: Exception did not transition to INVESTIGATING.",
      );
    }

    const claimedException =
      await prisma.operationalException.findUnique({
        where: {
          storeId_fingerprint: {
            storeId: store.id,
            fingerprint,
          },
        },
      });

    if (!claimedException) {
      throw new Error(
        "TEST FAILED: Claimed exception could not be reloaded.",
      );
    }

    const claimAudit =
      await prisma.auditEvent.findFirst({
        where: {
          tenantId: store.tenantId,
          storeId: store.id,
          action: "EXCEPTION_CLAIMED",
          entityType: "OPERATIONAL_EXCEPTION",
          entityId: exception.id,
        },
        orderBy: {
          occurredAt: "desc",
        },
      });

    if (!claimAudit) {
      throw new Error(
        "TEST FAILED: EXCEPTION_CLAIMED audit event was not persisted.",
      );
    }

    if (claimAudit.actorType !== "USER") {
      throw new Error(
        `TEST FAILED: Expected audit actorType USER, got ${claimAudit.actorType}`,
      );
    }

    if (claimAudit.actorId !== "e2e-operator") {
      throw new Error(
        `TEST FAILED: Expected audit actorId e2e-operator, got ${claimAudit.actorId}`,
      );
    }

    console.log("");
    console.log(
      "EXCEPTION CLAIM E2E PASSED: OPEN -> INVESTIGATING + AUDIT PERSISTED",
    );
    console.log(
      JSON.stringify(
        {
          exception: {
            id: claimedException.id,
            status: claimedException.status,
          },
          audit: {
            id: claimAudit.id,
            action: claimAudit.action,
            actorType: claimAudit.actorType,
            actorId: claimAudit.actorId,
            entityType: claimAudit.entityType,
            entityId: claimAudit.entityId,
          },
        },
        null,
        2,
      ),
    );
    // --------------------------------------------------
    // 5. REAL HTTP INVESTIGATION CONTEXT
    // --------------------------------------------------

    const investigationResponse =
      await fastify.inject({
        method: "GET",
        url:
          `/oms/exceptions/${exception.id}/investigation` +
          `?tenantId=${encodeURIComponent(store.tenantId)}` +
          `&storeId=${encodeURIComponent(store.id)}`,
      });

    console.log(
      `INVESTIGATION HTTP STATUS: ${investigationResponse.statusCode}`,
    );

    console.log(
      `INVESTIGATION HTTP BODY: ${investigationResponse.body}`,
    );

    if (investigationResponse.statusCode !== 200) {
      throw new Error(
        `TEST FAILED: Expected investigation HTTP 200, got ${investigationResponse.statusCode}`,
      );
    }

    let investigationContext: any;

    try {
      investigationContext =
        JSON.parse(investigationResponse.body);
    } catch {
      throw new Error(
        "TEST FAILED: Investigation endpoint returned invalid JSON.",
      );
    }

    if (investigationContext.exception?.id !== exception.id) {
      throw new Error(
        "TEST FAILED: Investigation context exception ID does not match.",
      );
    }

    if (
      investigationContext.exception?.status !==
      "INVESTIGATING"
    ) {
      throw new Error(
        `TEST FAILED: Expected investigation exception status INVESTIGATING, got ${String(
          investigationContext.exception?.status,
        )}`,
      );
    }

    if (investigationContext.order?.id !== order.id) {
      throw new Error(
        "TEST FAILED: Investigation context order does not match failed order.",
      );
    }

    if (
      investigationContext.affectedItem?.sku !==
      failedItem.sku
    ) {
      throw new Error(
        "TEST FAILED: Investigation context affected SKU does not match failed item.",
      );
    }

    if (
      investigationContext.affectedItem?.quantity !==
      requestedQty
    ) {
      throw new Error(
        `TEST FAILED: Investigation context quantity mismatch. Expected ${requestedQty}, got ${String(
          investigationContext.affectedItem?.quantity,
        )}`,
      );
    }

    if (
      investigationContext.inventory?.sku !==
      inventoryItem.sku
    ) {
      throw new Error(
        "TEST FAILED: Investigation context inventory SKU does not match source inventory.",
      );
    }

    if (
      investigationContext.inventory?.availableQty !==
      availableQty
    ) {
      throw new Error(
        `TEST FAILED: Investigation context available inventory mismatch. Expected ${availableQty}, got ${String(
          investigationContext.inventory?.availableQty,
        )}`,
      );
    }

    if (
      investigationContext.inventory?.isStale !==
      false
    ) {
      throw new Error(
        "TEST FAILED: Investigation context inventory was unexpectedly stale.",
      );
    }

    if (
      !Array.isArray(investigationContext.reservations)
    ) {
      throw new Error(
        "TEST FAILED: Investigation context reservations is not an array.",
      );
    }

    console.log("");
    console.log(
      "INVESTIGATION CONTEXT E2E PASSED: HTTP context matches exception + order + inventory",
    );

    console.log(
      JSON.stringify(
        {
          exception: {
            id: investigationContext.exception.id,
            status: investigationContext.exception.status,
          },
          order: {
            id: investigationContext.order?.id,
            orderNumber:
              investigationContext.order?.orderNumber,
          },
          affectedItem: {
            sku:
              investigationContext.affectedItem?.sku,
            quantity:
              investigationContext.affectedItem?.quantity,
          },
          inventory: {
            sku:
              investigationContext.inventory?.sku,
            availableQty:
              investigationContext.inventory?.availableQty,
            isStale:
              investigationContext.inventory?.isStale,
          },
          reservations:
            investigationContext.reservations.length,
        },
        null,
        2,
      ),
    );
    // --------------------------------------------------
    // 4. ASSERT THE BUSINESS FAILURE PATH
    // --------------------------------------------------

    if (order.status !== "FAILED") {
      throw new Error(
        `TEST FAILED: Expected order FAILED, got ${order.status}`,
      );
    }

    if (!exception) {
      throw new Error(
        "TEST FAILED: No operational exception persisted.",
      );
    }

    if (exception.status !== "OPEN") {
      throw new Error(
        `TEST FAILED: Expected exception OPEN, got ${exception.status}`,
      );
    }

    if (
      exception.category !==
      "ORDER_OPERATIONAL_RISK"
    ) {
      throw new Error(
        `TEST FAILED: Unexpected category ${exception.category}`,
      );
    }

    if (exception.severity !== "HIGH") {
      throw new Error(
        `TEST FAILED: Unexpected severity ${exception.severity}`,
      );
    }

    const evidence =
      exception.evidence as Record<string, unknown>;

    if (
      evidence.detectionStatus !==
      "INSUFFICIENT_INVENTORY"
    ) {
      throw new Error(
        `TEST FAILED: Unexpected detection status ${String(
          evidence.detectionStatus,
        )}`,
      );
    }

    if (
      Number(evidence.shortageQty) !==
      requestedQty - availableQty
    ) {
      throw new Error(
        "TEST FAILED: Incorrect shortage quantity.",
      );
    }

    console.log("");
    console.log(
      "WEBHOOK -> ORDER FAILURE -> EXCEPTION E2E PATH PASSED",
    );
    console.log("");

    // --------------------------------------------------
    // IMPORTANT ARCHITECTURAL OBSERVATION
    // --------------------------------------------------

    if (
      webhookEvent &&
      webhookEvent.status !== "PROCESSED"
    ) {
      console.log(
        `WEBHOOK STATUS OBSERVATION: ${webhookEvent.status}`,
      );

      console.log(
        "This confirms the current processor treats the business inventory failure as webhook-processing failure.",
      );
    }
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(
    "WEBHOOK -> ORDER FAILURE -> EXCEPTION E2E VERIFICATION FAILED",
  );

  console.error(
    error instanceof Error
      ? error.message
      : error,
  );

  process.exitCode = 1;
});








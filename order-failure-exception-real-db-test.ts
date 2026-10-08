import { NestFactory } from "@nestjs/core";
import { AppModule } from "./src/app.module";
import { PrismaService } from "./src/prisma/prisma.service";
import { OrderService } from "./src/oms/order/order.service";
import { ShopifyConnector } from "./src/connectors/shopify/shopify.connector";

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule);

  try {
    const prisma = app.get(PrismaService);
    const orderService = app.get(OrderService);

    const store = await prisma.storeConnection.findUnique({
      where: {
        platform_externalStoreId: {
          platform: "SHOPIFY",
          externalStoreId: "techmart-lab.myshopify.com",
        },
      },
      select: {
        id: true,
        tenantId: true,
        externalStoreId: true,
      },
    });

    if (!store) {
      throw new Error("Shopify store techmart-lab.myshopify.com not found.");
    }

    const inventoryItem = await prisma.inventoryItem.findFirst({
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
      throw new Error("sku-managed-1 inventory item not found.");
    }

    const availableQty = inventoryItem.balances.reduce(
      (total, balance) => total + balance.availableQty,
      0,
    );

    if (availableQty < 0) {
      throw new Error(`Invalid available inventory: ${availableQty}`);
    }

    const requestedQty = availableQty + 1;

    const externalOrderId = `techmart-real-failure-${Date.now()}`;
    const orderNumber = `#REAL-FAIL-${Date.now()}`;

    console.log(JSON.stringify({
      store: store.externalStoreId,
      tenantId: store.tenantId,
      storeId: store.id,
      sku: inventoryItem.sku,
      availableQty,
      requestedQty,
      externalOrderId,
      orderNumber,
    }, null, 2));

    let orderId: string | null = null;

    try {
      const connector = new ShopifyConnector({} as never, {} as never);
      await orderService.upsertFromChannel({
        tenantId: store.tenantId,
        storeId: store.id,
        order: connector.normalizeOrder({
          topic: "orders/create",
          payload: {
          id: externalOrderId,
          name: orderNumber,
          financial_status: "paid",
          fulfillment_status: null,
          total_price: "629.95",
          currency: "USD",
          created_at: new Date().toISOString(),
          line_items: [
            {
              id: `line-${Date.now()}`,
              sku: inventoryItem.sku,
              title: inventoryItem.name,
              quantity: requestedQty,
              price: "629.95",
            },
          ],
          },
        }),
      });

      throw new Error(
        "TEST FAILED: OrderService unexpectedly succeeded despite insufficient inventory.",
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("TEST FAILED:")
      ) {
        throw error;
      }

      console.log(
        `Expected reservation failure: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const order = await prisma.order.findUnique({
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
      throw new Error("TEST FAILED: OMS order was not persisted.");
    }

    orderId = order.id;

    const failedItem = order.items[0];

    if (!failedItem) {
      throw new Error("TEST FAILED: OMS order item was not persisted.");
    }

    const fingerprint =
      `ORDER_INVENTORY_FAILURE:${order.id}:${failedItem.id}`;

    const exception = await prisma.operationalException.findUnique({
      where: {
        storeId_fingerprint: {
          storeId: store.id,
          fingerprint,
        },
      },
    });

    const verification = {
      order: {
        id: order.id,
        number: order.orderNumber,
        status: order.status,
        itemSku: failedItem.sku,
        requestedQty: failedItem.quantity,
      },
      inventory: {
        availableQty,
        requestedQty,
        shortageQty: requestedQty - availableQty,
      },
      exception: exception
        ? {
            id: exception.id,
            status: exception.status,
            category: exception.category,
            severity: exception.severity,
            fingerprint: exception.fingerprint,
            evidence: exception.evidence,
          }
        : null,
    };

    console.log(JSON.stringify(verification, null, 2));

    if (order.status !== "FAILED") {
      throw new Error(
        `TEST FAILED: Expected order status FAILED, got ${order.status}`,
      );
    }

    if (!exception) {
      throw new Error(
        "TEST FAILED: Operational exception was not persisted.",
      );
    }

    if (exception.status !== "OPEN") {
      throw new Error(
        `TEST FAILED: Expected exception OPEN, got ${exception.status}`,
      );
    }

    if (exception.category !== "ORDER_OPERATIONAL_RISK") {
      throw new Error(
        `TEST FAILED: Unexpected exception category ${exception.category}`,
      );
    }

    if (exception.severity !== "HIGH") {
      throw new Error(
        `TEST FAILED: Unexpected exception severity ${exception.severity}`,
      );
    }

    const evidence = exception.evidence as Record<string, unknown>;

    if (evidence.detectionStatus !== "INSUFFICIENT_INVENTORY") {
      throw new Error(
        `TEST FAILED: Unexpected detection status ${String(
          evidence.detectionStatus,
        )}`,
      );
    }

    if (evidence.sku !== inventoryItem.sku) {
      throw new Error(
        `TEST FAILED: Exception SKU mismatch: ${String(evidence.sku)}`,
      );
    }

    if (Number(evidence.shortageQty) !== requestedQty - availableQty) {
      throw new Error(
        "TEST FAILED: Exception shortage quantity mismatch.",
      );
    }

    if (order.reservations.length !== 0) {
      throw new Error(
        `TEST FAILED: Failed order unexpectedly has ${order.reservations.length} reservation(s).`,
      );
    }

    console.log("");
    console.log("REAL ORDER FAILURE -> EXCEPTION PERSISTENCE PASSED");
    console.log("");
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(
    "REAL ORDER FAILURE -> EXCEPTION VERIFICATION FAILED",
  );
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

import { NestFactory } from "@nestjs/core";
import { AppModule } from "./src/app.module";
import { ShopifyInventoryService } from "./src/shopify/shopify-inventory.service";
import { PrismaService } from "./src/prisma/prisma.service";

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule);

  try {
    const syncService = app.get(ShopifyInventoryService);
    const prisma = app.get(PrismaService);

    const syncResult = await syncService.syncStoreInventory(
      "techmart-lab.myshopify.com",
    );

    const balances = await prisma.inventoryBalance.findMany({
      where: {
        inventoryItem: {
          sku: "sku-managed-1",
        },
      },
      include: {
        inventoryItem: true,
        location: true,
      },
    });

    console.log(
      JSON.stringify(
        {
          syncResult,
          balances: balances.map((balance) => ({
            sku: balance.inventoryItem.sku,
            location: balance.location.name,
            availableQty: balance.availableQty,
            reservedQty: balance.reservedQty,
            committedQty: balance.committedQty,
          })),
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
  console.error("INVENTORY VERIFICATION FAILED");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

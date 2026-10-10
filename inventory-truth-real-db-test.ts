import { NestFactory } from "@nestjs/core";
import { AppModule } from "./src/app.module";
import { PrismaService } from "./src/prisma/prisma.service";
import { tenantContextStorage } from "./src/prisma/tenant-context";
import { InventoryTruthService } from "./src/oms/inventory/inventory-truth.service";

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule);

  try {
    const prisma = app.get(PrismaService);
    const truthService = app.get(InventoryTruthService);

    const item = await prisma.inventoryItem.findFirst({
      where: {
        sku: "sku-managed-1",
      },
      select: {
        id: true,
        tenantId: true,
        sku: true,
        name: true,
      },
    });

    if (!item) {
      throw new Error("sku-managed-1 was not found in the database");
    }

    const truth = await truthService.getSkuTruth({
      tenantId: item.tenantId,
      sku: item.sku,
    });

    console.log(
      JSON.stringify(
        {
          sku: item.sku,
          name: item.name,
          inventoryItemId: item.id,
          truth,
        },
        null,
        2,
      ),
    );
  } finally {
    await app.close();
  }
}

// Runs as operator (RLS bypass): this verification script is not scoped
// to one tenant session. The truth lookup itself passes the tenant.
tenantContextStorage.run({ bypass: true }, () => main()).catch((error) => {
  console.error(
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});

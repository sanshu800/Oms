const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const TENANT_ID = "9d6b0542-cea8-45d5-a8a7-396f44509fac";
const EXTERNAL_STORE_ID = "c8d3ce82-d3a9-4840-a45b-57acd2877531";

async function main() {
  console.log("Resolving StoreConnection...");

  // EXTERNAL_STORE_ID is the platform's identifier.
  // Inventory tables must use the internal StoreConnection.id.
  const store = await prisma.storeConnection.findFirst({
    where: {
      tenantId: TENANT_ID,
      platform: "SHOPIFY",
      externalStoreId: EXTERNAL_STORE_ID,
      status: "ACTIVE",
    },
    select: {
      id: true,
      tenantId: true,
      platform: true,
      externalStoreId: true,
      externalStoreId: true,
      status: true,
    },
  });

  if (!store) {
    throw new Error(
      `StoreConnection not found for tenant=${TENANT_ID}, platform=SHOPIFY, externalStoreId=${EXTERNAL_STORE_ID}`
    );
  }

  console.log("StoreConnection resolved:");
  console.log(JSON.stringify(store, null, 2));

  const STORE_ID = store.id;

  console.log("\nCreating DEFAULT inventory location...");

  const location = await prisma.inventoryLocation.upsert({
    where: {
      storeId_code: {
        storeId: STORE_ID,
        code: "DEFAULT",
      },
    },
    update: {
      name: "Default Location",
      active: true,
    },
    create: {
      tenantId: TENANT_ID,
      storeId: STORE_ID,
      code: "DEFAULT",
      name: "Default Location",
      active: true,
    },
  });

  console.log("Inventory location:");
  console.log(JSON.stringify(location, null, 2));

  console.log("\nCreating test inventory item...");

  const item = await prisma.inventoryItem.upsert({
    where: {
      storeId_sku: {
        storeId: STORE_ID,
        sku: "TEST-SKU-001",
      },
    },
    update: {
      name: "Test Product",
      active: true,
    },
    create: {
      tenantId: TENANT_ID,
      storeId: STORE_ID,
      sku: "TEST-SKU-001",
      name: "Test Product",
      active: true,
    },
  });

  console.log("Inventory item:");
  console.log(JSON.stringify(item, null, 2));

  console.log("\nCreating/updating inventory balance...");

  const balance = await prisma.inventoryBalance.upsert({
    where: {
      inventoryItemId_locationId: {
        inventoryItemId: item.id,
        locationId: location.id,
      },
    },
    update: {
      availableQty: 10,
      reservedQty: 0,
      committedQty: 0,
    },
    create: {
      inventoryItemId: item.id,
      locationId: location.id,
      availableQty: 10,
      reservedQty: 0,
      committedQty: 0,
    },
  });

  console.log("Inventory balance:");
  console.log(JSON.stringify(balance, null, 2));

  console.log("\n=== INVENTORY SETUP COMPLETE ===");

  console.log(
    JSON.stringify(
      {
        store: {
          id: store.id,
          externalStoreId: store.externalStoreId,
          platform: store.platform,
        },
        location: {
          id: location.id,
          code: location.code,
          storeId: location.storeId,
        },
        item: {
          id: item.id,
          sku: item.sku,
          storeId: item.storeId,
        },
        balance: {
          id: balance.id,
          inventoryItemId: balance.inventoryItemId,
          locationId: balance.locationId,
          availableQty: balance.availableQty,
          reservedQty: balance.reservedQty,
          committedQty: balance.committedQty,
        },
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

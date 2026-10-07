const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const SHOP_DOMAIN = "test.myshopify.com";
const SKU = "TEST-SKU-001";

async function main() {
  console.log("=== MULTI-LOCATION INVENTORY TEST ===");

  // 1. Resolve the existing store
  const store = await prisma.storeConnection.findUnique({
    where: { shopDomain: SHOP_DOMAIN },
  });

  if (!store) {
    throw new Error(`Store not found: ${SHOP_DOMAIN}`);
  }

  console.log("\nStore:");
  console.log({
    id: store.id,
    externalStoreId: store.externalStoreId,
    shopDomain: store.shopDomain,
  });

  // 2. Resolve the existing inventory item
  const item = await prisma.inventoryItem.findUnique({
    where: {
      storeId_sku: {
        storeId: store.id,
        sku: SKU,
      },
    },
  });

  if (!item) {
    throw new Error(`Inventory item not found: ${SKU}`);
  }

  console.log("\nInventory item:");
  console.log({
    id: item.id,
    sku: item.sku,
    storeId: item.storeId,
  });

  // 3. Create the second location
  const location = await prisma.inventoryLocation.upsert({
    where: {
      storeId_code: {
        storeId: store.id,
        code: "WAREHOUSE-2",
      },
    },
    update: {
      name: "Warehouse 2",
      active: true,
    },
    create: {
      tenantId: store.tenantId,
      storeId: store.id,
      code: "WAREHOUSE-2",
      name: "Warehouse 2",
      active: true,
    },
  });

  console.log("\nSecond location:");
  console.log({
    id: location.id,
    code: location.code,
    storeId: location.storeId,
  });

  // 4. Create the independent balance for Warehouse 2
  const balance = await prisma.inventoryBalance.upsert({
    where: {
      inventoryItemId_locationId: {
        inventoryItemId: item.id,
        locationId: location.id,
      },
    },
    update: {
      availableQty: 25,
      reservedQty: 0,
      committedQty: 0,
    },
    create: {
      inventoryItemId: item.id,
      locationId: location.id,
      availableQty: 25,
      reservedQty: 0,
      committedQty: 0,
    },
  });

  console.log("\nWarehouse 2 balance:");
  console.log({
    id: balance.id,
    inventoryItemId: balance.inventoryItemId,
    locationId: balance.locationId,
    availableQty: balance.availableQty,
  });

  // 5. Fetch ALL balances for this SKU
  const balances = await prisma.inventoryBalance.findMany({
    where: {
      inventoryItemId: item.id,
    },
    include: {
      location: {
        select: {
          id: true,
          code: true,
          name: true,
        },
      },
    },
    orderBy: {
      location: {
        code: "asc",
      },
    },
  });

  console.log("\n=== ALL BALANCES FOR SKU ===");
  console.log(JSON.stringify(balances, null, 2));

  // 6. Validate the expected state
  const defaultBalance = balances.find(
    (b) => b.location.code === "DEFAULT"
  );

  const warehouse2Balance = balances.find(
    (b) => b.location.code === "WAREHOUSE-2"
  );

  if (!defaultBalance) {
    throw new Error("FAIL: DEFAULT balance not found");
  }

  if (!warehouse2Balance) {
    throw new Error("FAIL: WAREHOUSE-2 balance not found");
  }

  if (defaultBalance.availableQty !== 10) {
    throw new Error(
      `FAIL: DEFAULT expected 10, got ${defaultBalance.availableQty}`
    );
  }

  if (warehouse2Balance.availableQty !== 25) {
    throw new Error(
      `FAIL: WAREHOUSE-2 expected 25, got ${warehouse2Balance.availableQty}`
    );
  }

  if (balances.length !== 2) {
    throw new Error(
      `FAIL: Expected exactly 2 balances, got ${balances.length}`
    );
  }

  console.log("\nPASS: Independent location balances are working.");

  // 7. Explicitly test duplicate protection
  console.log("\n=== DUPLICATE BALANCE TEST ===");

  try {
    await prisma.inventoryBalance.create({
      data: {
        inventoryItemId: item.id,
        locationId: location.id,
        availableQty: 999,
        reservedQty: 0,
        committedQty: 0,
      },
    });

    throw new Error(
      "FAIL: Duplicate balance was created. Composite unique constraint is not protecting us."
    );
  } catch (error) {
    if (error.code === "P2002") {
      console.log(
        "PASS: Duplicate balance correctly rejected by unique constraint."
      );
    } else if (
      error.message.includes(
        "Duplicate balance was created"
      )
    ) {
      throw error;
    } else {
      throw error;
    }
  }

  console.log("\n=== MULTI-LOCATION TEST PASSED ===");
}

main()
  .catch((error) => {
    console.error("\nTEST FAILED:");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

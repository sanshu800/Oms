const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

async function main() {
  const inventoryItems = await prisma.$queryRawUnsafe(`
    SELECT
      id,
      "tenantId",
      "storeId",
      sku,
      "shopifyInventoryItemId"
    FROM "InventoryItem"
    ORDER BY "createdAt" ASC
  `);

  const balances = await prisma.$queryRawUnsafe(`
    SELECT *
    FROM "InventoryBalance"
    ORDER BY "createdAt" ASC
  `);

  const reservations = await prisma.$queryRawUnsafe(`
    SELECT *
    FROM "InventoryReservation"
    ORDER BY "createdAt" ASC
  `);

  const movements = await prisma.$queryRawUnsafe(`
    SELECT *
    FROM "InventoryMovement"
    ORDER BY "createdAt" ASC
  `);

  console.log("\n=== INVENTORY ITEMS ===");
  console.log(JSON.stringify(inventoryItems, null, 2));

  console.log("\n=== INVENTORY BALANCES ===");
  console.log(JSON.stringify(balances, null, 2));

  console.log("\n=== INVENTORY RESERVATIONS ===");
  console.log(JSON.stringify(reservations, null, 2));

  console.log("\n=== INVENTORY MOVEMENTS ===");
  console.log(JSON.stringify(movements, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

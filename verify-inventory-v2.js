const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

async function main() {
  const locations = await prisma.inventoryLocation.findMany({
    select: {
      id: true,
      tenantId: true,
      storeId: true,
      code: true,
      name: true,
      active: true,
    },
  });

  const balances = await prisma.inventoryBalance.findMany({
    select: {
      id: true,
      inventoryItemId: true,
      locationId: true,
      availableQty: true,
      reservedQty: true,
      committedQty: true,
    },
  });

  console.log("\n=== INVENTORY LOCATIONS ===");
  console.log(JSON.stringify(locations, null, 2));

  console.log("\n=== INVENTORY BALANCES ===");
  console.log(JSON.stringify(balances, null, 2));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());

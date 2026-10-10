require("dotenv").config();

const { PrismaClient } = require("@prisma/client");

const p = new PrismaClient();

async function main() {
  const raw = await p.$queryRawUnsafe(`
    SELECT id, "externalStoreId", platform, status
    FROM "StoreConnection"
  `);

  console.log("RAW SQL RESULT:");
  console.log(raw);

  const prisma = await p.storeConnection.findMany();

  console.log("PRISMA RESULT:");
  console.log(prisma);
}

main()
  .catch(console.error)
  .finally(() => p.$disconnect());

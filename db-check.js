require("dotenv").config();

const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();

async function main() {
  console.log("DATABASE:", process.env.DATABASE_URL);

  const raw = await p.$queryRaw`
    SELECT id, "shopDomain", status
    FROM "StoreConnection"
    WHERE "shopDomain" = 'test.myshopify.com'
  `;

  console.log("RAW SQL:");
  console.dir(raw, { depth: null });

  const all = await p.storeConnection.findMany({
    select: {
      id: true,
      shopDomain: true,
      status: true
    }
  });

  console.log("PRISMA:");
  console.dir(all, { depth: null });
}

main()
  .catch(console.error)
  .finally(() => p.$disconnect());

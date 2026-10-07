require("dotenv").config();

const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();

async function main() {
  const tenant = await p.tenant.findFirst();

  if (!tenant) {
    throw new Error("No tenant exists");
  }

  const store = await p.storeConnection.upsert({
    where: {
      shopDomain: "test.myshopify.com"
    },
    update: {
      status: "ACTIVE"
    },
    create: {
      tenantId: tenant.id,
      platform: "SHOPIFY",
      shopDomain: "test.myshopify.com",
      status: "ACTIVE",
      scopes: []
    }
  });

  console.log("STORE CREATED:");
  console.dir(store, { depth: null });
}

main()
  .catch(console.error)
  .finally(() => p.$disconnect());

const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const TENANT_ID = "9d6b0542-cea8-45d5-a8a7-396f44509fac";
const STORE_ID = "c8d3ce82-d3a9-4840-a45b-57acd2877531";

async function main() {
  console.log("Creating test tenant...");

  const tenant = await prisma.tenant.upsert({
    where: {
      id: TENANT_ID,
    },
    update: {
      name: "TechMart Test Tenant",
    },
    create: {
      id: TENANT_ID,
      name: "TechMart Test Tenant",
    },
  });

  console.log("Tenant:", tenant);

  console.log("Creating test Shopify store...");

  const store = await prisma.storeConnection.upsert({
    where: {
      shopDomain: "test.myshopify.com",
    },
    update: {
      tenantId: tenant.id,
      platform: "SHOPIFY",
      externalStoreId: STORE_ID,
      status: "ACTIVE",
    },
    create: {
      id: STORE_ID,
      tenantId: tenant.id,
      platform: "SHOPIFY",
      externalStoreId: STORE_ID,
      shopDomain: "test.myshopify.com",
      status: "ACTIVE",
    },
  });

  console.log("Store:", store);

  console.log("\n=== STORE SETUP COMPLETE ===");

  console.log(
    JSON.stringify(
      {
        tenant: {
          id: tenant.id,
          name: tenant.name,
        },
        store: {
          id: store.id,
          tenantId: store.tenantId,
          platform: store.platform,
          externalStoreId: store.externalStoreId,
          shopDomain: store.shopDomain,
          status: store.status,
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

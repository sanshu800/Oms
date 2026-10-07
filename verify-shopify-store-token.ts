import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const store = await prisma.storeConnection.findUnique({
    where: {
      shopDomain: "techmart-lab.myshopify.com",
    },
  });

  if (!store) {
    throw new Error("Store connection not found");
  }

  if (!store.encryptedAccessToken) {
    throw new Error("Store access token is not available");
  }

  console.log("Store found:", store.shopDomain);
  console.log("Access token available: YES");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

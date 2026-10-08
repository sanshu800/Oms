require("dotenv").config();

const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();

async function main() {
  const events = await p.webhookEvent.findMany({
    orderBy: { receivedAt: "desc" },
    take: 10,
    select: {
      id: true,
      storeId: true,
      externalEventId: true,
      topic: true,
      status: true,
      attempts: true,
      receivedAt: true,
      processedAt: true,
      lastError: true
    }
  });

  console.dir(events, { depth: null });
}

main()
  .catch(console.error)
  .finally(() => p.$disconnect());

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { ConfigService } from "@nestjs/config";
import { Queue } from "bullmq";

import { PrismaService } from "./src/prisma/prisma.service";
import { TenantApiKeyService } from "./src/auth/tenant-api-key.service";
import { ShopifyAuthService } from "./src/shopify/shopify-auth.service";
import { ExceptionService } from "./src/oms/exception/exception.service";
import { RiskDetectorService } from "./src/oms/risk/risk-detector.service";
import { AiInvestigationQueueService } from "./src/ai/queue/ai-investigation.queue";

async function main() {
  const prisma = new PrismaService();
  const config = new ConfigService({ ENCRYPTION_KEY: process.env.ENCRYPTION_KEY });
  const tenantApiKeyService = new TenantApiKeyService(prisma);
  const shopifyAuth = new ShopifyAuthService(config, prisma, tenantApiKeyService);

  const shopDomain = "ui-demo-shop.myshopify.com";

  await prisma.runAsSystem(() => prisma.storeConnection.deleteMany({ where: { externalStoreId: shopDomain } }));

  const install = await shopifyAuth.activateStore(shopDomain, "fake-token", ["read_orders"]);

  const queue = new Queue("ai-investigation", { connection: { host: "localhost", port: 6379 } });
  const aiQueue = new AiInvestigationQueueService(queue as any);
  const exceptionService = new ExceptionService(prisma, aiQueue);
  const riskDetector = new RiskDetectorService(prisma, exceptionService);

  await prisma.runAsTenant(install.tenantId, async () => {
    const location = await prisma.inventoryLocation.create({
      data: { tenantId: install.tenantId, code: "UI-DEMO", name: "Main Warehouse" },
    });
    const item = await prisma.inventoryItem.create({
      data: { tenantId: install.tenantId, sku: "DEMO-WIDGET-01", name: "Demo Widget" },
    });
    await prisma.inventoryBalance.create({
      data: { inventoryItemId: item.id, locationId: location.id, availableQty: -4, reservedQty: 0 },
    });

    await riskDetector.detect({ tenantId: install.tenantId, storeId: install.id });
  });

  await queue.close();
  await prisma.$disconnect();

  console.log(JSON.stringify({ tenantId: install.tenantId, storeId: install.id, apiKey: install.apiKey }, null, 2));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

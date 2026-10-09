import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";

import { HealthController } from "./health.controller";
import { validateEnvironment } from "./config/environment";
import { ShopifyModule } from "./shopify/shopify.module";
import { WebhooksModule } from "./webhooks/webhooks.module";

import { PrismaModule } from "./prisma/prisma.module";

import { OrderModule } from "./oms/order/order.module";
import { ExceptionModule } from "./oms/exception/exception.module";
import { AuditModule } from "./oms/audit/audit.module";
import { InventoryModule } from "./oms/inventory/inventory.module";
import { FulfillmentModule } from "./oms/fulfillment/fulfillment.module";
import { RiskModule } from "./oms/risk/risk.module";
import { ResolutionModule } from "./oms/resolution/resolution.module";
import { WmsModule } from "./wms/wms.module";

import { QueueModule } from "./queue/queue.module";

import { AiModule } from "./ai/ai.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnvironment,
    }),

    PrismaModule,
    ShopifyModule,
    WebhooksModule,

    OrderModule,
    ExceptionModule,
    AuditModule,
    InventoryModule,
    FulfillmentModule,
    RiskModule,
    ResolutionModule,
    WmsModule,

    QueueModule,

    AiModule,
  ],

  controllers: [HealthController],
})
export class AppModule {}

import { Module } from "@nestjs/common";

import { PrismaModule } from "../prisma/prisma.module";
import { QueueModule } from "../queue/queue.module";

import { ShopifyController } from "./shopify.controller";
import { WebhookIntakeService } from "./webhook-intake.service";

/**
 * Webhook intake: signature verification, durable storage of the raw
 * delivery, and handing the event to the processing queue. Kept separate
 * from `ShopifyModule` (OAuth/app credentials) so additional channel
 * receivers can be added here without touching Shopify auth.
 */
@Module({
  imports: [PrismaModule, QueueModule],
  controllers: [ShopifyController],
  providers: [WebhookIntakeService],
  exports: [WebhookIntakeService],
})
export class WebhooksModule {}

import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { BullModule } from "@nestjs/bullmq";

import { PrismaModule } from "../prisma/prisma.module";
import { ConnectorsModule } from "../connectors/connectors.module";
import { OrderModule } from "../oms/order/order.module";
import { AuditModule } from "../oms/audit/audit.module";
import { ExceptionModule } from "../oms/exception/exception.module";
import { ResolutionModule } from "../oms/resolution/resolution.module";

import {
  WEBHOOK_QUEUE,
  WebhookQueueService,
} from "./webhook.queue";

import { WebhookProcessorService } from "../webhooks/webhook-processor/webhook-processor.service";
import { WebhookWorker } from "./webhook.worker";
import { parseRedisConnectionOptions } from "../config/redis-connection";

@Module({
  imports: [
    PrismaModule,
    ConnectorsModule,
    OrderModule,
    AuditModule,
    ExceptionModule,
    ResolutionModule,

    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: parseRedisConnectionOptions(
          configService.getOrThrow<string>("REDIS_URL"),
        ),

        defaultJobOptions: {
          attempts: 5,
          backoff: {
            type: "exponential",
            delay: 1000,
          },
          removeOnComplete: 1000,
          removeOnFail: false,
        },
      }),
    }),

    BullModule.registerQueue({
      name: WEBHOOK_QUEUE,
    }),
  ],

  providers: [
    WebhookProcessorService,
    WebhookQueueService,
    WebhookWorker,
  ],

  exports: [
    WebhookQueueService,
  ],
})
export class QueueModule {}


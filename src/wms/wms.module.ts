import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { BullModule } from "@nestjs/bullmq";

import { AuditModule } from "../oms/audit/audit.module";
import { FulfillmentModule } from "../oms/fulfillment/fulfillment.module";
import { PrismaModule } from "../prisma/prisma.module";
import { WEBHOOK_QUEUE } from "../queue/webhook.queue";
import { WmsEventQueueService } from "../queue/wms-event.queue";

import { FakeWmsAdapter } from "./fake/fake-wms.adapter";
import {
  WMS_ADAPTERS,
  WMS_EVENT_QUEUE,
  WmsAdapter,
} from "./wms-contract";
import { WmsConnectionService } from "./wms-connection.service";
import { WmsController } from "./wms.controller";
import { WmsEventIntakeService } from "./wms-event-intake.service";
import { WmsEventProcessorService } from "./wms-event-processor.service";
import { WmsRequestService } from "./wms-request.service";

/**
 * WMS integration foundation (Stage 1).
 *
 * Registers the provider adapters (the deterministic FAKE only — no real
 * WMS product is integrated), wires the durable event pipeline onto the
 * EXISTING BullMQ queue, and exposes the inbound/outbound HTTP surface.
 * Adding a real WMS provider means adding its adapter here — nothing else
 * in the system changes.
 */
@Module({
  imports: [
    PrismaModule,
    FulfillmentModule,
    AuditModule,
    BullModule.registerQueue({
      name: WEBHOOK_QUEUE,
    }),
  ],
  controllers: [WmsController],
  providers: [
    {
      provide: WMS_ADAPTERS,
      useFactory: (config: ConfigService): WmsAdapter[] => [
        new FakeWmsAdapter(config),
      ],
      inject: [ConfigService],
    },
    WmsConnectionService,
    WmsRequestService,
    WmsEventIntakeService,
    WmsEventProcessorService,
    WmsEventQueueService,
    {
      provide: WMS_EVENT_QUEUE,
      useExisting: WmsEventQueueService,
    },
  ],
  exports: [
    WMS_ADAPTERS,
    WmsConnectionService,
    WmsRequestService,
    WmsEventIntakeService,
    WmsEventProcessorService,
  ],
})
export class WmsModule {}

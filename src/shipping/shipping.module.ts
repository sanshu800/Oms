import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { BullModule } from "@nestjs/bullmq";

import { AuthModule } from "../auth/auth.module";
import { AuditModule } from "../oms/audit/audit.module";
import { FulfillmentModule } from "../oms/fulfillment/fulfillment.module";
import { PrismaModule } from "../prisma/prisma.module";
import { WEBHOOK_QUEUE } from "../queue/webhook.queue";
import { ShippingEventQueueService } from "../queue/shipping-event.queue";

import { FakeShippingProviderAdapter } from "./fake/fake-shipping.adapter";
import {
  SHIPPING_ADAPTERS,
  SHIPPING_EVENT_QUEUE,
  ShippingProviderAdapter,
} from "./shipping-contract";
import { ShippingConnectionService } from "./shipping-connection.service";
import { ShippingController } from "./shipping.controller";
import { ShippingEventIntakeService } from "./shipping-event-intake.service";
import { ShippingEventProcessorService } from "./shipping-event-processor.service";
import { ShippingRequestService } from "./shipping-request.service";

/**
 * Shipping-provider integration foundation (Stage 2).
 *
 * Registers the provider adapters (the deterministic FAKE only — no real
 * shipping provider is integrated), wires the durable event pipeline onto
 * the EXISTING BullMQ queue, and exposes the inbound/outbound HTTP
 * surface. Adding a real shipping provider means adding its adapter here —
 * nothing else in the system changes.
 */
@Module({
  imports: [
    PrismaModule,
    AuthModule,
    FulfillmentModule,
    AuditModule,
    BullModule.registerQueue({
      name: WEBHOOK_QUEUE,
    }),
  ],
  controllers: [ShippingController],
  providers: [
    {
      provide: SHIPPING_ADAPTERS,
      useFactory: (config: ConfigService): ShippingProviderAdapter[] => [
        new FakeShippingProviderAdapter(config),
      ],
      inject: [ConfigService],
    },
    ShippingConnectionService,
    ShippingRequestService,
    ShippingEventIntakeService,
    ShippingEventProcessorService,
    ShippingEventQueueService,
    {
      provide: SHIPPING_EVENT_QUEUE,
      useExisting: ShippingEventQueueService,
    },
  ],
  exports: [
    SHIPPING_ADAPTERS,
    ShippingConnectionService,
    ShippingRequestService,
    ShippingEventIntakeService,
    ShippingEventProcessorService,
  ],
})
export class ShippingModule {}

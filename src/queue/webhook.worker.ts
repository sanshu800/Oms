import { Injectable, Logger } from "@nestjs/common";

import { Processor, WorkerHost } from "@nestjs/bullmq";

import { Job } from "bullmq";

import { WebhookProcessorService } from "../webhooks/webhook-processor/webhook-processor.service";
import { ShippingEventProcessorService } from "../shipping/shipping-event-processor.service";
import { WmsEventProcessorService } from "../wms/wms-event-processor.service";

import { SHIPPING_EVENT_JOB } from "./shipping-event.queue";
import { WMS_EVENT_JOB } from "./wms-event.queue";
import { WEBHOOK_JOB, WEBHOOK_QUEUE } from "./webhook.queue";

type WebhookJobData = {
  webhookEventId: string;
};

type WmsEventJobData = {
  wmsEventId: string;
};

type ShippingEventJobData = {
  shippingEventId: string;
};

/**
 * The integration job worker: processes channel webhook jobs, WMS
 * warehouse-event jobs, and shipping-event jobs from the shared durable
 * queue, dispatching by job name. All job types share the queue's
 * retry/backoff/dead-letter configuration (queue.module.ts).
 */
@Injectable()
@Processor(WEBHOOK_QUEUE)
export class WebhookWorker extends WorkerHost {
  private readonly logger = new Logger(WebhookWorker.name);

  constructor(
    private readonly webhookProcessor: WebhookProcessorService,
    private readonly wmsEventProcessor: WmsEventProcessorService,
    private readonly shippingEventProcessor: ShippingEventProcessorService,
  ) {
    super();
  }

  async process(
    job: Job<WebhookJobData | WmsEventJobData | ShippingEventJobData>,
  ): Promise<void> {
    if (job.name === WMS_EVENT_JOB) {
      const { wmsEventId } = job.data as WmsEventJobData;

      const attempt = job.attemptsMade + 1;

      const maxAttempts =
        typeof job.opts.attempts === "number" && job.opts.attempts > 0
          ? job.opts.attempts
          : 1;

      this.logger.log(
        `Processing WMS event job ${job.id} for event ${wmsEventId} (attempt ${attempt}/${maxAttempts})`,
      );

      await this.wmsEventProcessor.processEvent(wmsEventId, {
        attempt,
        maxAttempts,
      });

      this.logger.log(
        `WMS event job ${job.id} completed for event ${wmsEventId}`,
      );

      return;
    }

    if (job.name === SHIPPING_EVENT_JOB) {
      const { shippingEventId } = job.data as ShippingEventJobData;

      const attempt = job.attemptsMade + 1;

      const maxAttempts =
        typeof job.opts.attempts === "number" && job.opts.attempts > 0
          ? job.opts.attempts
          : 1;

      this.logger.log(
        `Processing shipping event job ${job.id} for event ${shippingEventId} (attempt ${attempt}/${maxAttempts})`,
      );

      await this.shippingEventProcessor.processEvent(shippingEventId, {
        attempt,
        maxAttempts,
      });

      this.logger.log(
        `Shipping event job ${job.id} completed for event ${shippingEventId}`,
      );

      return;
    }

    if (job.name !== WEBHOOK_JOB) {
      this.logger.warn(`Ignoring unknown webhook job: ${job.name}`);

      return;
    }

    const { webhookEventId } = job.data as WebhookJobData;

    const attempt = job.attemptsMade + 1;

    const maxAttempts =
      typeof job.opts.attempts === "number" && job.opts.attempts > 0
        ? job.opts.attempts
        : 1;

    this.logger.log(
      `Processing webhook job ${job.id} for event ${webhookEventId} (attempt ${attempt}/${maxAttempts})`,
    );

    await this.webhookProcessor.processEvent(webhookEventId, {
      attempt,
      maxAttempts,
    });

    this.logger.log(
      `Webhook job ${job.id} completed for event ${webhookEventId}`,
    );
  }
}

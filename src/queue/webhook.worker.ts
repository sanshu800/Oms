import { Injectable, Logger } from "@nestjs/common";

import { Processor, WorkerHost } from "@nestjs/bullmq";

import { Job } from "bullmq";

import { WebhookProcessorService } from "../webhooks/webhook-processor/webhook-processor.service";
import { WmsEventProcessorService } from "../wms/wms-event-processor.service";

import { WMS_EVENT_JOB } from "./wms-event.queue";
import { WEBHOOK_JOB, WEBHOOK_QUEUE } from "./webhook.queue";

type WebhookJobData = {
  webhookEventId: string;
};

type WmsEventJobData = {
  wmsEventId: string;
};

/**
 * The integration job worker: processes channel webhook jobs and WMS
 * warehouse-event jobs from the shared durable queue, dispatching by job
 * name. Both job types share the queue's retry/backoff/dead-letter
 * configuration (queue.module.ts).
 */
@Injectable()
@Processor(WEBHOOK_QUEUE)
export class WebhookWorker extends WorkerHost {
  private readonly logger = new Logger(WebhookWorker.name);

  constructor(
    private readonly webhookProcessor: WebhookProcessorService,
    private readonly wmsEventProcessor: WmsEventProcessorService,
  ) {
    super();
  }

  async process(job: Job<WebhookJobData | WmsEventJobData>): Promise<void> {
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

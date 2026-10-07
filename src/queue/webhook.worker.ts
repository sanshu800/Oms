import { Injectable, Logger } from "@nestjs/common";

import { Processor, WorkerHost } from "@nestjs/bullmq";

import { Job } from "bullmq";

import { WebhookProcessorService } from "../webhooks/webhook-processor/webhook-processor.service";

import { WEBHOOK_JOB, WEBHOOK_QUEUE } from "./webhook.queue";

type WebhookJobData = {
  webhookEventId: string;
};

@Injectable()
@Processor(WEBHOOK_QUEUE)
export class WebhookWorker extends WorkerHost {
  private readonly logger = new Logger(WebhookWorker.name);

  constructor(private readonly webhookProcessor: WebhookProcessorService) {
    super();
  }

  async process(job: Job<WebhookJobData>): Promise<void> {
    if (job.name !== WEBHOOK_JOB) {
      this.logger.warn(`Ignoring unknown webhook job: ${job.name}`);

      return;
    }

    const { webhookEventId } = job.data;

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

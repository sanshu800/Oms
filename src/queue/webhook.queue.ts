import { Injectable } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";

export const WEBHOOK_QUEUE =
  "webhook-processing";

export const WEBHOOK_JOB =
  "process-webhook";

@Injectable()
export class WebhookQueueService {
  constructor(
    @InjectQueue(WEBHOOK_QUEUE)
    private readonly queue: Queue,
  ) {}

  async enqueue(
    webhookEventId: string,
  ): Promise<void> {
    await this.queue.add(
      WEBHOOK_JOB,
      {
        webhookEventId,
      },
      {
        jobId: webhookEventId,
      },
    );
  }
}
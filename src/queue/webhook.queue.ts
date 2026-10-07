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

  /**
   * Re-add a job for an event that already had one.
   *
   * BullMQ ignores `add` when a job with the same id still exists — and
   * failed jobs are kept (`removeOnFail: false`) precisely so they can be
   * inspected. Without removing the previous job first, replaying a
   * failed webhook would look successful while nothing ever runs.
   */
  async requeue(webhookEventId: string): Promise<void> {
    try {
      await this.queue.remove(webhookEventId);
    } catch (error) {
      // A job that is currently locked/active cannot be removed; the
      // claim on the event row still prevents double processing, so this
      // is logged by the caller's failure path rather than swallowed.
      throw new Error(
        `Could not clear the previous webhook job ${webhookEventId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    await this.enqueue(webhookEventId);
  }
}
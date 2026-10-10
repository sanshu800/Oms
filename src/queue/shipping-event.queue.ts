import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import { Queue } from "bullmq";

import { ShippingEventQueue } from "../shipping/shipping-contract";

import { WEBHOOK_QUEUE } from "./webhook.queue";

export const SHIPPING_EVENT_JOB = "process-shipping-event";

/**
 * Durable queueing for shipping events — implemented on the EXISTING
 * BullMQ queue (same Redis, same queue, same retry/dead-letter options as
 * webhook and WMS jobs). Stage 2 introduces no new queue technology; the
 * worker distinguishes job types by name (see WebhookWorker).
 */
@Injectable()
export class ShippingEventQueueService implements ShippingEventQueue {
  constructor(
    @InjectQueue(WEBHOOK_QUEUE)
    private readonly queue: Queue,
  ) {}

  async enqueue(shippingEventId: string): Promise<void> {
    await this.queue.add(
      SHIPPING_EVENT_JOB,
      {
        shippingEventId,
      },
      {
        jobId: shippingEventId,
      },
    );
  }

  /**
   * Re-add a job for an event that already had one (BullMQ ignores `add`
   * while a job with the same id exists; failed jobs are kept for
   * inspection). Mirrors WebhookQueueService.requeue.
   */
  async requeue(shippingEventId: string): Promise<void> {
    try {
      await this.queue.remove(shippingEventId);
    } catch (error) {
      throw new Error(
        `Could not clear the previous shipping event job ${shippingEventId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    await this.enqueue(shippingEventId);
  }
}

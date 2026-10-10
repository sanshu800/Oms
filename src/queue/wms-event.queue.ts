import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import { Queue } from "bullmq";

import { WmsEventQueue } from "../wms/wms-contract";

import { WEBHOOK_QUEUE } from "./webhook.queue";

export const WMS_EVENT_JOB = "process-wms-event";

/**
 * Durable queueing for WMS events — implemented on the EXISTING BullMQ
 * queue (same Redis, same queue, same retry/dead-letter options as
 * webhook jobs). Stage 1 introduces no new queue technology; the worker
 * distinguishes job types by name (see WebhookWorker).
 */
@Injectable()
export class WmsEventQueueService implements WmsEventQueue {
  constructor(
    @InjectQueue(WEBHOOK_QUEUE)
    private readonly queue: Queue,
  ) {}

  async enqueue(wmsEventId: string): Promise<void> {
    await this.queue.add(
      WMS_EVENT_JOB,
      {
        wmsEventId,
      },
      {
        jobId: wmsEventId,
      },
    );
  }

  /**
   * Re-add a job for an event that already had one (BullMQ ignores `add`
   * while a job with the same id exists; failed jobs are kept for
   * inspection). Mirrors WebhookQueueService.requeue.
   */
  async requeue(wmsEventId: string): Promise<void> {
    try {
      await this.queue.remove(wmsEventId);
    } catch (error) {
      throw new Error(
        `Could not clear the previous WMS event job ${wmsEventId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    await this.enqueue(wmsEventId);
  }
}

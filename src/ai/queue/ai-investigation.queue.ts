import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";

export const AI_INVESTIGATION_QUEUE = "ai-investigation";
export const AI_INVESTIGATION_JOB = "investigate-exception";

export type AiInvestigationJobData = {
  tenantId: string;
  storeId: string;
  exceptionId: string;
};

/**
 * Not every exception category is a good candidate for AI
 * investigation yet. WEBHOOK_PROCESSING failures are infra/retry
 * concerns already handled by the queue's own retry/dead-letter
 * mechanism (see WebhookProcessorService) — an LLM investigating a
 * transient network error adds cost without adding insight. The OMS
 * integrity categories are exactly the kind of "something is wrong,
 * why, what should happen next" question the agent is built for.
 */
export const AI_ELIGIBLE_EXCEPTION_CATEGORIES = [
  "INVENTORY_INTEGRITY",
  "RESERVATION_INTEGRITY",
  "FULFILLMENT_INTEGRITY",
  "SHIPMENT_INTEGRITY",
  "ORDER_INTEGRITY",
] as const;

@Injectable()
export class AiInvestigationQueueService {
  private readonly logger = new Logger(AiInvestigationQueueService.name);

  constructor(
    @InjectQueue(AI_INVESTIGATION_QUEUE)
    private readonly queue: Queue,
  ) {}

  isEligibleCategory(category: string): boolean {
    return (AI_ELIGIBLE_EXCEPTION_CATEGORIES as readonly string[]).includes(
      category,
    );
  }

  async enqueue(input: AiInvestigationJobData): Promise<void> {
    try {
      await this.queue.add(AI_INVESTIGATION_JOB, input);
    } catch (error) {
      // Enqueuing an investigation must never break the deterministic
      // exception pipeline that triggered it — the exception itself
      // is already persisted and correct either way.
      this.logger.error(
        `Failed to enqueue AI investigation for exception ${input.exceptionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue } from "bullmq";

export const AI_INVESTIGATION_QUEUE = "ai-investigation";
export const AI_INVESTIGATION_JOB = "investigate-exception";
export const AI_RECOVERY_JOB = "recover-abandoned";
export const AI_RECOVERY_SWEEP_JOB_ID = "recover-abandoned-sweep";

export type AiInvestigationJobData = {
  tenantId: string;
  storeId: string;
  exceptionId: string;
  /**
   * Optional stable identity of the operational dispatch (one per raise /
   * re-open event). When present it becomes the BullMQ jobId so the same
   * dispatch enqueued twice cannot run twice. Independent from the
   * persistence-level one-active-investigation guarantee.
   */
  dispatchKey?: string;
};

export const AI_ELIGIBLE_EXCEPTION_CATEGORIES = [
  "INVENTORY_SHORTAGE",
  "RESERVATION_INTEGRITY",
  "FULFILLMENT_INTEGRITY",
  "SHIPMENT_INTEGRITY",
  "ORDER_INTEGRITY",
] as const;

function clampInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(Math.max(Math.floor(value), min), max);
}

@Injectable()
export class AiInvestigationQueueService implements OnModuleInit {
  private readonly logger = new Logger(AiInvestigationQueueService.name);

  constructor(
    @InjectQueue(AI_INVESTIGATION_QUEUE)
    private readonly queue: Queue,
    private readonly config: ConfigService,
  ) {
    // A broker outage must LOG, not crash: connection error events without
    // a listener become uncaught exceptions at teardown.
    this.queue.on("error", (error: unknown) => {
      this.logger.error(
        `AI investigation queue error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  async onModuleInit(): Promise<void> {
    // Bounded recovery sweep (Phase 2B Task 4): a repeatable job with a
    // fixed id — idempotent across restarts — that re-dispatches abandoned
    // RUNNING investigations (expired execution leases). Interval 0
    // disables the sweep (recovery then only happens on dispatch).
    //
    // Registration is fire-and-forget: it must never block application
    // boot when the broker is slow or unreachable (the worker still runs
    // recovery on its own schedule once the broker is up).
    const intervalMs = clampInt(
      this.config.get("AI_RECOVERY_SWEEP_INTERVAL_MS"),
      60_000,
      0,
      Number.MAX_SAFE_INTEGER,
    );

    if (intervalMs <= 0) {
      return;
    }

    void this.queue
      .add(
        AI_RECOVERY_JOB,
        {},
        {
          jobId: AI_RECOVERY_SWEEP_JOB_ID,
          repeat: { every: intervalMs },
          removeOnComplete: true,
          removeOnFail: 100,
        },
      )
      .catch((error: unknown) => {
        this.logger.error(
          `Failed to register the recovery sweep job: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }

  isEligibleCategory(category: string): boolean {
    return (AI_ELIGIBLE_EXCEPTION_CATEGORIES as readonly string[]).includes(
      category,
    );
  }

  /**
   * Phase 2B queue reliability: explicit bounded attempts + exponential
   * backoff with configurable limits, and failed jobs RETAINED (not
   * silently discarded) so an operator can identify and inspect exhausted
   * dispatches. There is no uncontrolled retry: attempts are capped and
   * terminal exhaustion is recorded to the audit log by the worker.
   */
  async enqueue(input: AiInvestigationJobData): Promise<void> {
    const attempts = clampInt(
      this.config.get("AI_INVESTIGATION_JOB_ATTEMPTS"),
      5,
      1,
      10,
    );
    const backoffMs = clampInt(
      this.config.get("AI_INVESTIGATION_JOB_BACKOFF_MS"),
      5_000,
      100,
      600_000,
    );
    const removeOnFail = clampInt(
      this.config.get("AI_INVESTIGATION_JOB_REMOVE_ON_FAIL"),
      500,
      0,
      100_000,
    );

    try {
      await this.queue.add(AI_INVESTIGATION_JOB, input, {
        jobId: input.dispatchKey
          ? `investigate:${input.dispatchKey}`
          : undefined,
        attempts,
        backoff: {
          type: "exponential",
          delay: backoffMs,
        },
        removeOnComplete: 1000,
        removeOnFail,
      });
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

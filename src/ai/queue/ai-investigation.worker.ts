import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { AuditActorType } from "@prisma/client";
import { Job, Queue } from "bullmq";

import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../../oms/audit/audit.service";
import { AiInvestigationService } from "../investigation/ai-investigation.service";
import {
  AI_INVESTIGATION_JOB,
  AI_INVESTIGATION_QUEUE,
  AI_RECOVERY_JOB,
  AiInvestigationJobData,
} from "./ai-investigation.queue";

/**
 * Phase 2B job-level reliability contract:
 *
 * - `investigate()` NEVER throws for business or model failures — it always
 *   persists an authoritative terminal outcome (COMPLETED/FAILED) and
 *   returns it. Those are PERMANENT for the job: it completes.
 * - `investigate()` throws only when it could not record any authoritative
 *   outcome (infrastructure failure — e.g. the database was unreachable
 *   even for the failure record). Those are RETRYABLE: the job rethrows so
 *   BullMQ retries with the configured exponential backoff, bounded by the
 *   configured attempts.
 * - When the final attempt fails, the exhaustion is recorded durably
 *   (audit event AI_INVESTIGATION_JOB_EXHAUSTED) and the job is RETAINED in
 *   the queue's failed set (removeOnFail > 0) — never silently discarded.
 * - Abandoned RUNNING investigations are recovered by the bounded
 *   `recover-abandoned` sweep (Task 4), including those left behind when a
 *   worker dies mid-run and the job later exhausts its retries.
 */
@Injectable()
@Processor(AI_INVESTIGATION_QUEUE)
export class AiInvestigationWorker extends WorkerHost {
  private readonly logger = new Logger(AiInvestigationWorker.name);

  constructor(
    private readonly aiInvestigationService: AiInvestigationService,
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    @InjectQueue(AI_INVESTIGATION_QUEUE)
    private readonly queue: Queue,
  ) {
    super();
  }

  async process(job: Job<AiInvestigationJobData | Record<string, never>>): Promise<void> {
    if (job.name === AI_RECOVERY_JOB) {
      await this.processRecoverySweep(job);

      return;
    }

    if (job.name !== AI_INVESTIGATION_JOB) {
      this.logger.warn(`Ignoring unknown AI investigation job: ${job.name}`);

      return;
    }

    const { tenantId, storeId, exceptionId } = job.data as AiInvestigationJobData;

    this.logger.log(
      `Investigating exception ${exceptionId} (job ${job.id})`,
    );

    try {
      // AiInvestigationService.investigate() never throws on business or
      // model failures — every such failure path is caught internally and
      // persisted as a FAILED AiInvestigation with an audited reason. It
      // throws only when no authoritative outcome could be recorded.
      const result = await this.prisma.runAsTenant(tenantId, () =>
        this.aiInvestigationService.investigate({
          tenantId,
          storeId,
          exceptionId,
          // Redelivery (retry after failure, or stall recovery after a
          // terminated consumer): BullMQ proved the previous owner is gone,
          // so allow lease takeover instead of waiting for lease expiry.
          // attemptsStarted > 1 covers stall redelivery (attemptsMade is
          // only incremented on explicit failures).
          takeoverClaim:
            job.attemptsMade > 0 ||
            (typeof job.attemptsStarted === "number" &&
              job.attemptsStarted > 1),
        }),
      );

      if (result.status === "FAILED") {
        if (result.attachedToActiveRun) {
          this.logger.log(
            `Dispatch for exception ${exceptionId} (job ${job.id}) coalesced onto active/authoritative investigation ${result.investigationId}: ${result.error ?? "done"}`,
          );
        } else {
          this.logger.warn(
            `Investigation ${result.investigationId} for exception ${exceptionId} failed: ${result.error}`,
          );
        }

        return;
      }

      this.logger.log(
        `Investigation ${result.investigationId} for exception ${exceptionId} completed with proposal ${result.proposalId}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const maxAttempts =
        typeof job.opts.attempts === "number" && job.opts.attempts > 0
          ? job.opts.attempts
          : 1;
      const attempt = job.attemptsMade + 1;

      if (attempt >= maxAttempts) {
        // Terminal exhaustion: record durably BEFORE rethrowing so the
        // failed-set entry is always backed by a queryable audit record.
        // Runs inside the job's tenant context — audit writes are RLS-scoped.
        await this.prisma.runAsTenant(tenantId, () =>
          this.auditService.recordEvent({
            tenantId,
            storeId,
            action: "AI_INVESTIGATION_JOB_EXHAUSTED",
            actorType: AuditActorType.AI_AGENT,
            entityType: "AI_INVESTIGATION",
            entityId: typeof job.id === "string" ? job.id : exceptionId,
            metadata: {
              exceptionId,
              jobId: job.id ?? null,
              attempts: attempt,
              error: message,
            },
          }),
        );
      }

      // Retryable infrastructure failure: let BullMQ apply the configured
      // bounded retry/backoff; beyond the cap the job stays in the failed
      // set for operator inspection (see the queue service's removeOnFail).
      throw error;
    }
  }

  private async processRecoverySweep(
    job: Job<AiInvestigationJobData | Record<string, never>>,
  ): Promise<void> {
    // The sweep spans tenants by design (it is not tied to one dispatch),
    // so it runs as the system — the same established pattern as internal
    // maintenance reads — never as an unscoped app-role query.
    const result = await this.prisma.runAsSystem(() =>
      this.aiInvestigationService.recoverAbandonedInvestigations(),
    );

    for (const action of result.actions) {
      if (action.action !== "redispatch") {
        continue;
      }

      // Controlled recovery: re-enqueue a normal investigation job for the
      // abandoned run. Its scope re-attaches to the SAME authoritative row
      // (resume semantics) — no duplicate records, no duplicate proposals.
      //
      // Job-id shape must be exactly 3 colon-separated parts (BullMQ
      // rejects custom ids containing ':' unless split(':').length === 3),
      // and unique per redispatch so a later sweep can recover again.
      const dispatchKey = `recovery:${action.investigationId}-${Date.now()}`;

      try {
        await this.queue.add(
          AI_INVESTIGATION_JOB,
          {
            tenantId: action.tenantId,
            storeId: action.storeId,
            exceptionId: action.exceptionId,
            dispatchKey,
          },
          {
            // Deterministic job id — the SAME dedupe contract as regular
            // dispatches (a repeated sweep cannot double-enqueue a recovery).
            jobId: `investigate:${dispatchKey}`,
            attempts: 1,
            removeOnComplete: 1000,
            removeOnFail: 100,
          },
        );
      } catch (addError) {
        // One failed redispatch must not fail the whole sweep (a failing
        // sweep job would retry and re-run every recovery side effect).
        this.logger.error(
          `Recovery redispatch for investigation ${action.investigationId} failed: ${
            addError instanceof Error ? addError.message : String(addError)
          }`,
        );
      }
    }

    this.logger.log(
      `Recovery sweep (job ${job.id}): scanned ${result.scanned}, redispatched ${
        result.actions.filter((a) => a.action === "redispatch").length
      }, abandoned ${result.actions.filter((a) => a.action === "abandoned").length}`,
    );
  }
}

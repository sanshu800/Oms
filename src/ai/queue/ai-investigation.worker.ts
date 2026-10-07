import { Injectable, Logger } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";

import { PrismaService } from "../../prisma/prisma.service";
import { AiInvestigationService } from "../investigation/ai-investigation.service";
import {
  AI_INVESTIGATION_JOB,
  AI_INVESTIGATION_QUEUE,
  AiInvestigationJobData,
} from "./ai-investigation.queue";

@Injectable()
@Processor(AI_INVESTIGATION_QUEUE)
export class AiInvestigationWorker extends WorkerHost {
  private readonly logger = new Logger(AiInvestigationWorker.name);

  constructor(
    private readonly aiInvestigationService: AiInvestigationService,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  async process(job: Job<AiInvestigationJobData>): Promise<void> {
    if (job.name !== AI_INVESTIGATION_JOB) {
      this.logger.warn(`Ignoring unknown AI investigation job: ${job.name}`);

      return;
    }

    const { tenantId, storeId, exceptionId } = job.data;

    this.logger.log(
      `Investigating exception ${exceptionId} (job ${job.id})`,
    );

    // AiInvestigationService.investigate() already never throws — every
    // failure path is caught internally and persisted as a FAILED
    // AiInvestigation with an audited reason. We still log the result
    // here for operational visibility of the worker itself.
    const result = await this.prisma.runAsTenant(tenantId, () =>
      this.aiInvestigationService.investigate({
        tenantId,
        storeId,
        exceptionId,
      }),
    );

    if (result.status === "FAILED") {
      this.logger.warn(
        `Investigation ${result.investigationId} for exception ${exceptionId} failed: ${result.error}`,
      );

      return;
    }

    this.logger.log(
      `Investigation ${result.investigationId} for exception ${exceptionId} completed with proposal ${result.proposalId}`,
    );
  }
}

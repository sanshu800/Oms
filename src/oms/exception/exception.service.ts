import { Injectable } from "@nestjs/common";
import { ExceptionSeverity, ExceptionStatus, Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { AiInvestigationQueueService } from "../../ai/queue/ai-investigation.queue";

@Injectable()
export class ExceptionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiInvestigationQueue: AiInvestigationQueueService,
  ) {}

  /**
   * Create an operational exception or update the existing
   * exception identified by store + fingerprint.
   *
   * The fingerprint is the operational identity of the condition.
   * Repeated active signals are deduplicated; a condition that
   * returns after resolution reopens the same exception record.
   *
   * This is the canonical entry point for operational risk creation.
   */
  async createOrUpdateException(input: {
    tenantId: string;
    storeId: string;
    fingerprint: string;
    category: string;
    severity: ExceptionSeverity;
    title: string;
    evidence: Prisma.InputJsonValue;
    recommendedNextStep: string;
  }) {
    const existing = await this.prisma.operationalException.findUnique({
      where: {
        storeId_fingerprint: {
          storeId: input.storeId,
          fingerprint: input.fingerprint,
        },
      },
      select: {
        id: true,
        status: true,
      },
    });

    const exception = await this.prisma.operationalException.upsert({
      where: {
        storeId_fingerprint: {
          storeId: input.storeId,
          fingerprint: input.fingerprint,
        },
      },

      create: {
        tenantId: input.tenantId,
        storeId: input.storeId,
        fingerprint: input.fingerprint,
        category: input.category,
        severity: input.severity,
        status: ExceptionStatus.OPEN,
        title: input.title,
        evidence: input.evidence,
        recommendedNextStep: input.recommendedNextStep,
      },

      update: {
        category: input.category,
        severity: input.severity,
        title: input.title,
        evidence: input.evidence,
        recommendedNextStep: input.recommendedNextStep,

        // A previously resolved operational condition may return.
        // Re-open the same fingerprint instead of creating a duplicate.
        status: ExceptionStatus.OPEN,
        resolvedAt: null,
      },
    });

    // Only trigger a fresh AI investigation when this is a genuinely
    // new signal (first time seen, or reopened after resolution) —
    // not on every repeated detection pass while it's already OPEN or
    // being investigated. Re-investigating an unchanged, already-known
    // condition on every risk-detector run would be pure LLM cost with
    // no new insight.
    const isNewOrReopened =
      !existing || existing.status === ExceptionStatus.RESOLVED;

    if (
      isNewOrReopened &&
      this.aiInvestigationQueue.isEligibleCategory(input.category)
    ) {
      await this.aiInvestigationQueue.enqueue({
        tenantId: input.tenantId,
        storeId: input.storeId,
        exceptionId: exception.id,
      });
    }

    return exception;
  }

  /**
   * Semantic alias used by operational modules.
   */
  async raise(input: {
    tenantId: string;
    storeId: string;
    fingerprint: string;
    category: string;
    severity: ExceptionSeverity;
    title: string;
    evidence: Prisma.InputJsonValue;
    recommendedNextStep: string;
  }) {
    return this.createOrUpdateException(input);
  }

  /**
   * Claim an operational exception for human/AI investigation.
   *
   * Claiming is represented by the INVESTIGATING lifecycle state.
   * A resolved exception cannot be claimed again.
   */
  async claim(input: {
    tenantId: string;
    storeId: string;
    exceptionId: string;
  }) {
    const exception = await this.prisma.operationalException.findFirst({
      where: {
        id: input.exceptionId,
        tenantId: input.tenantId,
        storeId: input.storeId,
      },
    });

    if (!exception) {
      throw new Error("Operational exception not found");
    }

    if (exception.status === ExceptionStatus.RESOLVED) {
      throw new Error("Resolved operational exception cannot be claimed");
    }

    if (exception.status === ExceptionStatus.INVESTIGATING) {
      return exception;
    }

    return this.prisma.operationalException.update({
      where: {
        id: exception.id,
      },
      data: {
        status: ExceptionStatus.INVESTIGATING,
      },
    });
  }
  /**
   * Resolve an operational exception.
   */
  async resolve(input: {
    tenantId: string;
    storeId: string;
    exceptionId: string;
  }) {
    const exception = await this.prisma.operationalException.findFirst({
      where: {
        id: input.exceptionId,
        tenantId: input.tenantId,
        storeId: input.storeId,
      },
    });

    if (!exception) {
      throw new Error("Operational exception not found");
    }

    if (exception.status === ExceptionStatus.RESOLVED) {
      return exception;
    }

    return this.prisma.operationalException.update({
      where: {
        id: exception.id,
      },
      data: {
        status: ExceptionStatus.RESOLVED,
        resolvedAt: new Date(),
      },
    });
  }

  /**
   * Semantic alias retained for existing callers.
   */
  async resolveException(input: {
    tenantId: string;
    storeId: string;
    exceptionId: string;
  }) {
    return this.resolve(input);
  }

  /**
   * Re-open an exception explicitly.
   *
   * Used when verification determines that the operational
   * condition still exists after a previous resolution.
   */
  async reopen(input: {
    tenantId: string;
    storeId: string;
    exceptionId: string;
    evidence?: Prisma.InputJsonValue;
    recommendedNextStep?: string;
  }) {
    const exception = await this.prisma.operationalException.findFirst({
      where: {
        id: input.exceptionId,
        tenantId: input.tenantId,
        storeId: input.storeId,
      },
    });

    if (!exception) {
      throw new Error("Operational exception not found");
    }

    return this.prisma.operationalException.update({
      where: {
        id: exception.id,
      },
      data: {
        status: ExceptionStatus.OPEN,
        resolvedAt: null,
        ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
        ...(input.recommendedNextStep !== undefined
          ? {
              recommendedNextStep: input.recommendedNextStep,
            }
          : {}),
      },
    });
  }

  /**
   * Return currently open operational exceptions.
   *
   * Highest-severity exceptions are returned first,
   * followed by newest detections.
   */
  /**
   * General-purpose listing for the UI: any status (defaults to
   * OPEN + INVESTIGATING, i.e. "needs attention"), optional severity
   * filter, newest first.
   */
  async list(input: {
    tenantId: string;
    storeId: string;
    status?: ExceptionStatus;
    severity?: ExceptionSeverity;
  }) {
    return this.prisma.operationalException.findMany({
      where: {
        tenantId: input.tenantId,
        storeId: input.storeId,
        status: input.status
          ? input.status
          : { in: [ExceptionStatus.OPEN, ExceptionStatus.INVESTIGATING] },
        ...(input.severity ? { severity: input.severity } : {}),
      },
      orderBy: [{ detectedAt: "desc" }],
    });
  }

  async getOpenExceptions(input: {
    tenantId: string;
    storeId: string;
    severity?: ExceptionSeverity;
  }) {
    return this.prisma.operationalException.findMany({
      where: {
        tenantId: input.tenantId,
        storeId: input.storeId,
        status: ExceptionStatus.OPEN,
        ...(input.severity ? { severity: input.severity } : {}),
      },

      orderBy: [
        {
          detectedAt: "desc",
        },
      ],
    });
  }

  /**
   * Backward-compatible method used by existing callers.
   */
  async getOpenExceptionsLegacy(input: {
    tenantId: string;
    storeId: string;
    severity?: ExceptionSeverity;
  }) {
    return this.getOpenExceptions(input);
  }

  /**
   * Retrieve one exception inside its tenant/store boundary.
   */
  async getById(input: {
    tenantId: string;
    storeId: string;
    exceptionId: string;
  }) {
    return this.prisma.operationalException.findFirst({
      where: {
        id: input.exceptionId,
        tenantId: input.tenantId,
        storeId: input.storeId,
      },
    });
  }

  /**
   * Existing API retained for compatibility.
   */
  async getExceptionById(input: {
    tenantId: string;
    storeId: string;
    exceptionId: string;
  }) {
    return this.getById(input);
  }
}



import { Injectable } from "@nestjs/common";
import { AiAutonomyLevel } from "@prisma/client";

import { PrismaService } from "../../prisma/prisma.service";
import { AUTONOMY_ACTOR_ID } from "./ai-decision.service";

export type AutonomyPolicyInput = {
  tenantId: string;
  actionType: string;
  autonomyLevel: AiAutonomyLevel;
  confidenceThreshold: number;
  maxActionsPerHour: number;
  enabled: boolean;
};

/**
 * Policy storage/lookup only — the actual decision of whether a given
 * proposal qualifies lives in AiAutonomyService, which also enforces
 * hard safety rails (like the LOW-risk-only rule) that no policy can
 * override, however it's configured.
 */
@Injectable()
export class AiAutonomyPolicyService {
  constructor(private readonly prisma: PrismaService) {}

  async getPolicy(input: { tenantId: string; actionType: string }) {
    return this.prisma.aiAutonomyPolicy.findUnique({
      where: {
        tenantId_actionType: {
          tenantId: input.tenantId,
          actionType: input.actionType,
        },
      },
    });
  }

  async listPolicies(input: { tenantId: string }) {
    return this.prisma.aiAutonomyPolicy.findMany({
      where: { tenantId: input.tenantId },
      orderBy: { actionType: "asc" },
    });
  }

  async upsertPolicy(input: AutonomyPolicyInput) {
    return this.prisma.aiAutonomyPolicy.upsert({
      where: {
        tenantId_actionType: {
          tenantId: input.tenantId,
          actionType: input.actionType,
        },
      },
      create: {
        tenantId: input.tenantId,
        actionType: input.actionType,
        autonomyLevel: input.autonomyLevel,
        confidenceThreshold: input.confidenceThreshold,
        maxActionsPerHour: input.maxActionsPerHour,
        enabled: input.enabled,
      },
      update: {
        autonomyLevel: input.autonomyLevel,
        confidenceThreshold: input.confidenceThreshold,
        maxActionsPerHour: input.maxActionsPerHour,
        enabled: input.enabled,
      },
    });
  }

  /**
   * Blast-radius check: how many proposals of this actionType has the
   * autonomy policy itself (not a human) executed for this tenant in
   * the last hour. A policy with maxActionsPerHour = 0 means
   * unlimited within this check (still bounded by the LOW-risk-tier
   * and confidence-threshold gates in AiAutonomyService).
   */
  async countRecentAutoExecutions(input: {
    tenantId: string;
    actionType: string;
    windowMs: number;
  }): Promise<number> {
    const since = new Date(Date.now() - input.windowMs);

    return this.prisma.aiDecisionProposal.count({
      where: {
        tenantId: input.tenantId,
        actionType: input.actionType,
        decidedBy: AUTONOMY_ACTOR_ID,
        decidedAt: { gte: since },
      },
    });
  }
}

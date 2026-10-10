import { Injectable, Logger } from "@nestjs/common";
import {
  AiAutonomyLevel,
  AiDecisionProposalStatus,
  AiRiskTier,
  AuditActorType,
} from "@prisma/client";

import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../../oms/audit/audit.service";
import { AiAutonomyPolicyService } from "./ai-autonomy-policy.service";
import { AiDecisionService, AUTONOMY_ACTOR_ID } from "./ai-decision.service";

const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Decides whether a freshly-created proposal qualifies for
 * auto-execution under an AiAutonomyPolicy, and if so, executes it
 * through the exact same AiDecisionService.approve() path a human
 * approval would use — same execution primitive, same independent
 * verification, same memory/audit writes. The only thing different
 * is who's attributed as the decider.
 *
 * Safety rails here are NOT configurable by policy — they apply no
 * matter what a tenant's policy says:
 *  - Only LOW riskTier proposals are ever considered. A policy can
 *    lower the bar within LOW (via confidenceThreshold) but can never
 *    open the door to MEDIUM/HIGH auto-execution.
 *  - RELEASE_ORDER_RESERVATION is human-only, always: no policy can
 *    auto-execute it (safeguard — it changes inventory state in ways
 *    that require explicit human authorization).
 *  - A policy must exist, be enabled, and be AUTO_BELOW_THRESHOLD.
 *    No policy row = no autonomy, by construction (the schema default
 *    is RECOMMEND_ONLY / disabled).
 */
@Injectable()
export class AiAutonomyService {
  private readonly logger = new Logger(AiAutonomyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly policyService: AiAutonomyPolicyService,
    private readonly aiDecisionService: AiDecisionService,
  ) {}

  async maybeAutoExecute(input: {
    tenantId: string;
    storeId: string;
    proposalId: string;
  }): Promise<void> {
    try {
      const proposal = await this.prisma.aiDecisionProposal.findFirst({
        where: {
          id: input.proposalId,
          tenantId: input.tenantId,
          storeId: input.storeId,
        },
      });

      if (!proposal || proposal.status !== AiDecisionProposalStatus.PROPOSED) {
        return;
      }

      if (proposal.riskTier !== AiRiskTier.LOW) {
        return;
      }

      // Hard rail: inventory-release actions require explicit human
      // approval no matter how the policy is configured. Leave the
      // proposal PROPOSED for human review.
      if (proposal.actionType === "RELEASE_ORDER_RESERVATION") {
        await this.auditService.recordEvent({
          tenantId: input.tenantId,
          storeId: input.storeId,
          action: "AI_AUTONOMY_HUMAN_ONLY_ACTION",
          actorType: AuditActorType.SYSTEM,
          entityType: "AI_DECISION_PROPOSAL",
          entityId: proposal.id,
          metadata: {
            actionType: proposal.actionType,
            reason:
              "RELEASE_ORDER_RESERVATION is human-only; auto-execution skipped regardless of policy",
          },
        });

        return;
      }

      const policy = await this.policyService.getPolicy({
        tenantId: input.tenantId,
        actionType: proposal.actionType,
      });

      if (
        !policy ||
        !policy.enabled ||
        policy.autonomyLevel !== AiAutonomyLevel.AUTO_BELOW_THRESHOLD
      ) {
        return;
      }

      if (proposal.confidence < policy.confidenceThreshold) {
        return;
      }

      if (policy.maxActionsPerHour > 0) {
        const recentCount = await this.policyService.countRecentAutoExecutions({
          tenantId: input.tenantId,
          actionType: proposal.actionType,
          windowMs: ONE_HOUR_MS,
        });

        if (recentCount >= policy.maxActionsPerHour) {
          await this.auditService.recordEvent({
            tenantId: input.tenantId,
            storeId: input.storeId,
            action: "AI_AUTONOMY_THROTTLED",
            actorType: AuditActorType.SYSTEM,
            entityType: "AI_DECISION_PROPOSAL",
            entityId: proposal.id,
            metadata: {
              actionType: proposal.actionType,
              maxActionsPerHour: policy.maxActionsPerHour,
              recentCount,
            },
          });

          return;
        }
      }

      await this.aiDecisionService.approve({
        tenantId: input.tenantId,
        storeId: input.storeId,
        proposalId: proposal.id,
        actorId: AUTONOMY_ACTOR_ID,
        note: `Auto-executed: confidence ${proposal.confidence} >= threshold ${policy.confidenceThreshold} under an active AiAutonomyPolicy.`,
        actorType: AuditActorType.SYSTEM,
      });
    } catch (error) {
      // Autonomy evaluation is an enrichment on top of the
      // recommend-only path, never a replacement for it — a failure
      // here must leave the proposal PROPOSED for human review, not
      // crash the investigation that created it.
      this.logger.error(
        `Autonomy evaluation failed for proposal ${input.proposalId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

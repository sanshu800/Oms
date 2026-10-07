import { Injectable, Logger } from "@nestjs/common";
import { AiDecisionProposalStatus } from "@prisma/client";

import { PrismaService } from "../../prisma/prisma.service";
import { AUTONOMY_ACTOR_ID } from "../decision/autonomy-actor.constant";

const APPROVED_STATUSES: AiDecisionProposalStatus[] = [
  AiDecisionProposalStatus.APPROVED,
  AiDecisionProposalStatus.EXECUTED,
];

const REJECTED_STATUSES: AiDecisionProposalStatus[] = [
  AiDecisionProposalStatus.REJECTED,
  AiDecisionProposalStatus.EXECUTION_FAILED,
];

/**
 * Semantic memory: standing, tenant-scoped beliefs derived from real
 * human decisions on past proposals — not the model's own past
 * confidence claims, which would just be the model believing itself.
 *
 * Facts are always recomputed fresh from AiDecisionProposal ground
 * truth (never parsed back out of a previous fact's text) and are
 * superseded, not appended: the old belief stays in history for
 * audit, the new row is the current one.
 */
@Injectable()
export class AiMemoryService {
  private readonly logger = new Logger(AiMemoryService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Call after a proposal receives a human decision. Recomputes the
   * approval/rejection track record for this tenant's
   * (category, actionType) pairing and writes a fresh fact
   * superseding whatever the previous belief was.
   */
  async recordProposalOutcome(input: {
    tenantId: string;
    proposalId: string;
  }): Promise<void> {
    try {
      const proposal = await this.prisma.aiDecisionProposal.findUnique({
        where: { id: input.proposalId },
        include: { exception: { select: { category: true } } },
      });

      if (!proposal) {
        return;
      }

      const category = proposal.exception.category;
      const actionType = proposal.actionType;
      const memoryCategory = `${category}:${actionType}`;

      const history = await this.prisma.aiDecisionProposal.findMany({
        where: {
          tenantId: input.tenantId,
          actionType,
          exception: { category },
          status: { not: AiDecisionProposalStatus.PROPOSED },
        },
        select: { status: true, decidedBy: true },
      });

      const approvedCount = history.filter((row) =>
        APPROVED_STATUSES.includes(row.status),
      ).length;

      const rejectedCount = history.filter((row) =>
        REJECTED_STATUSES.includes(row.status),
      ).length;

      const total = approvedCount + rejectedCount;

      if (total === 0) {
        return;
      }

      const confidence = approvedCount / total;

      const autoExecutedCount = history.filter(
        (row) => row.decidedBy === AUTONOMY_ACTOR_ID,
      ).length;

      const humanCount = total - autoExecutedCount;

      // Never claim "human reviewers" decided something an autonomy
      // policy actually decided — the memory system must stay honest
      // about its own provenance, not just about the OMS facts it
      // reasons over.
      const decidedByClause =
        autoExecutedCount === 0
          ? "by human reviewers"
          : humanCount === 0
            ? "by the autonomy policy (no human review yet)"
            : `by human reviewers (${humanCount}) and the autonomy policy (${autoExecutedCount})`;

      const fact =
        `${approvedCount} approved and ${rejectedCount} rejected out of ${total} ` +
        `"${actionType}" proposal(s) for "${category}" exceptions in this tenant, decided ${decidedByClause}. ` +
        `Most recent decision: ${proposal.status}.`;

      const previous = await this.prisma.aiMemoryFact.findFirst({
        where: { tenantId: input.tenantId, category: memoryCategory },
        orderBy: { createdAt: "desc" },
      });

      await this.prisma.aiMemoryFact.create({
        data: {
          tenantId: input.tenantId,
          category: memoryCategory,
          fact,
          confidence,
          sourceInvestigationId: proposal.investigationId,
          supersedesId: previous?.id,
        },
      });
    } catch (error) {
      // Memory is an enrichment, not a critical path — a failure here
      // must never block the human decision that triggered it.
      this.logger.error(
        `Failed to record memory outcome for proposal ${input.proposalId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Current beliefs for a tenant, optionally narrowed to one
   * category. "Current" = the most recent fact per (category)
   * key — superseded rows are excluded by construction since we
   * only take the latest per key.
   */
  async getCurrentFacts(input: { tenantId: string; category?: string }) {
    const facts = await this.prisma.aiMemoryFact.findMany({
      where: {
        tenantId: input.tenantId,
        ...(input.category
          ? { category: { startsWith: input.category } }
          : {}),
      },
      orderBy: { createdAt: "desc" },
    });

    const latestByCategory = new Map<string, (typeof facts)[number]>();

    for (const fact of facts) {
      if (!latestByCategory.has(fact.category)) {
        latestByCategory.set(fact.category, fact);
      }
    }

    return Array.from(latestByCategory.values());
  }
}

import { Injectable, NotFoundException } from "@nestjs/common";
import {
  AiDecisionProposalStatus,
  AiOutcome,
  AuditActorType,
  InventoryMovementType,
  InventoryReservationStatus,
  OrderStatus,
} from "@prisma/client";

import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../../oms/audit/audit.service";
import { InventoryService } from "../../oms/inventory/inventory.service";
import { AiMemoryService } from "../memory/ai-memory.service";
import { AiActuationService } from "../actuation/ai-actuation.service";

export type AiDecisionContext = {
  tenantId: string;
  storeId: string;
};

export type ApproveProposalInput = AiDecisionContext & {
  proposalId: string;
  actorId: string;
  note?: string;
  /**
   * Defaults to USER (a human approved it). Phase 7's autonomy
   * service passes SYSTEM when a proven, low-risk proposal is
   * auto-executed under an AiAutonomyPolicy instead of a human
   * decision — same execution/verification code path either way.
   */
  actorType?: AuditActorType;
};

export { AUTONOMY_ACTOR_ID } from "./autonomy-actor.constant";

export type RejectProposalInput = AiDecisionContext & {
  proposalId: string;
  actorId: string;
  note?: string;
};

/**
 * Action types the platform actually knows how to execute today.
 * Everything else an AI proposes can be approved (the human decision
 * is still recorded) but nothing is automatically done.
 *
 * RELEASE_ORDER_RESERVATION is internal (no external write).
 * ADD_ORDER_NOTE is Phase 8's first real cross-system action — it
 * goes through AiActuationService to a real ShopifyActionAdapter
 * write, gated on the store having actually granted the write scope.
 */
const EXECUTABLE_ACTION_TYPES = [
  "RELEASE_ORDER_RESERVATION",
  "ADD_ORDER_NOTE",
] as const;

/**
 * Defense in depth, independent of the schema-level validation at
 * proposal-submission time: even if a stale or manually-inserted
 * proposal somehow has the wrong targetEntityType for its actionType,
 * approval must never execute against the wrong entity. A silent
 * no-op that gets reported as "verified" would be worse than doing
 * nothing.
 */
const REQUIRED_TARGET_ENTITY_TYPE: Record<string, string> = {
  RELEASE_ORDER_RESERVATION: "ORDER",
  ADD_ORDER_NOTE: "ORDER",
};

@Injectable()
export class AiDecisionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly inventoryService: InventoryService,
    private readonly aiMemoryService: AiMemoryService,
    private readonly aiActuationService: AiActuationService,
  ) {}

  /**
   * Cross-exception proposal inbox for the UI: everything awaiting a
   * decision (defaults to PROPOSED) for a store, newest first, with
   * enough of the parent exception's own fields to render a useful
   * list without a second round-trip per row.
   */
  async listProposals(
    input: AiDecisionContext & { status?: AiDecisionProposalStatus },
  ) {
    const proposals = await this.prisma.aiDecisionProposal.findMany({
      where: {
        tenantId: input.tenantId,
        storeId: input.storeId,
        status: input.status ?? AiDecisionProposalStatus.PROPOSED,
      },
      orderBy: { createdAt: "desc" },
      include: {
        exception: {
          select: {
            title: true,
            category: true,
            severity: true,
            status: true,
          },
        },
      },
    });

    return { count: proposals.length, proposals };
  }

  /**
   * Full investigation context for one exception: every proposal
   * raised for it, each with its investigation's tool-call trace, so
   * a human reviewer can see exactly what evidence the agent gathered
   * before recommending anything.
   */
  async getExceptionProposals(
    input: AiDecisionContext & { exceptionId: string },
  ) {
    const proposals = await this.prisma.aiDecisionProposal.findMany({
      where: {
        tenantId: input.tenantId,
        storeId: input.storeId,
        exceptionId: input.exceptionId,
      },
      orderBy: { createdAt: "desc" },
      include: {
        investigation: {
          include: {
            toolCalls: { orderBy: { sequence: "asc" } },
          },
        },
        feedback: { orderBy: { createdAt: "asc" } },
      },
    });

    return { count: proposals.length, proposals };
  }

  async getProposal(input: AiDecisionContext & { proposalId: string }) {
    const proposal = await this.prisma.aiDecisionProposal.findFirst({
      where: {
        id: input.proposalId,
        tenantId: input.tenantId,
        storeId: input.storeId,
      },
      include: {
        investigation: {
          include: {
            toolCalls: { orderBy: { sequence: "asc" } },
          },
        },
        feedback: { orderBy: { createdAt: "asc" } },
      },
    });

    if (!proposal) {
      throw new NotFoundException(
        "AI decision proposal not found in this tenant/store",
      );
    }

    return proposal;
  }

  async approve(input: ApproveProposalInput) {
    const actorType = input.actorType ?? AuditActorType.USER;
    const proposal = await this.getProposalForApproval(input);

    // Idempotent replay (safeguard: retries and repeated execution must
    // not re-execute): a proposal that already reached an execution
    // outcome returns its recorded result. A different outcome requires
    // a new investigation and a fresh proposal — renewed authorization.
    if (
      proposal.status === AiDecisionProposalStatus.EXECUTED ||
      proposal.status === AiDecisionProposalStatus.EXECUTION_FAILED
    ) {
      const priorFeedback = await this.prisma.aiOutcomeFeedback.findFirst({
        where: { proposalId: proposal.id },
        orderBy: { createdAt: "desc" },
      });

      const executed = proposal.status === AiDecisionProposalStatus.EXECUTED;

      return {
        ...proposal,
        executed,
        verified: executed,
        replayed: true,
        error: executed
          ? undefined
          : ((priorFeedback?.observedResult as { executionError?: string } | null)
              ?.executionError ?? "execution previously failed"),
      };
    }

    const requiredTargetType = REQUIRED_TARGET_ENTITY_TYPE[proposal.actionType];

    const executable =
      (EXECUTABLE_ACTION_TYPES as readonly string[]).includes(
        proposal.actionType,
      ) &&
      (!requiredTargetType || proposal.targetEntityType === requiredTargetType);

    if (!executable) {
      const updated = await this.prisma.aiDecisionProposal.update({
        where: { id: proposal.id },
        data: {
          status: AiDecisionProposalStatus.APPROVED,
          decidedAt: new Date(),
          decidedBy: input.actorId,
        },
      });

      await this.recordFeedback(input, AiOutcome.APPROVED);
      await this.aiMemoryService.recordProposalOutcome({
        tenantId: input.tenantId,
        proposalId: proposal.id,
      });

      const mismatched =
        requiredTargetType && proposal.targetEntityType !== requiredTargetType;

      await this.auditService.recordEvent({
        tenantId: input.tenantId,
        storeId: input.storeId,
        action: "AI_PROPOSAL_APPROVED",
        actorType,
        actorId: input.actorId,
        entityType: "AI_DECISION_PROPOSAL",
        entityId: proposal.id,
        metadata: {
          actionType: proposal.actionType,
          executed: false,
          reason: mismatched
            ? `Refused to execute: actionType ${proposal.actionType} requires targetEntityType ${requiredTargetType}, but this proposal has ${proposal.targetEntityType}. Approved as a recorded decision only.`
            : "No actuation capability exists yet for this actionType; decision recorded only.",
        },
      });

      return {
        ...updated,
        executed: false,
        verified: false,
        replayed: false,
        error: undefined,
      };
    }

    // Hard safety rail (safeguard: RELEASE_ORDER_RESERVATION stays behind
    // explicit human approval): a system/autonomy actor can never execute
    // it, no matter what an AiAutonomyPolicy enables. The proposal stays
    // PROPOSED so a human's later approval is the renewed authorization.
    if (
      proposal.actionType === "RELEASE_ORDER_RESERVATION" &&
      actorType !== AuditActorType.USER
    ) {
      throw new Error(
        "RELEASE_ORDER_RESERVATION requires explicit human approval; system/autonomy actors may not execute it",
      );
    }

    // Known-safe, already-implemented action: reuse the exact same
    // primitive and independent-verification discipline
    // ResolutionService uses for its own deterministic path, just
    // orchestrated from proposal approval instead of exception
    // resolution.
    await this.auditService.recordEvent({
      tenantId: input.tenantId,
      storeId: input.storeId,
      action: "AI_PROPOSAL_APPROVED",
      actorType,
      actorId: input.actorId,
      entityType: "AI_DECISION_PROPOSAL",
      entityId: proposal.id,
      metadata: { actionType: proposal.actionType },
    });

    let executionResult: unknown;
    let executionError: string | undefined;

    try {
      executionResult = await this.executeAction(input, proposal);
    } catch (error) {
      executionError = error instanceof Error ? error.message : String(error);
    }

    if (executionError) {
      const failed = await this.prisma.aiDecisionProposal.update({
        where: { id: proposal.id },
        data: {
          status: AiDecisionProposalStatus.EXECUTION_FAILED,
          decidedAt: new Date(),
          decidedBy: input.actorId,
        },
      });

      await this.recordFeedback(input, AiOutcome.APPROVED, {
        executionError,
      });
      await this.aiMemoryService.recordProposalOutcome({
        tenantId: input.tenantId,
        proposalId: proposal.id,
      });

      await this.auditService.recordEvent({
        tenantId: input.tenantId,
        storeId: input.storeId,
        action: "AI_PROPOSAL_EXECUTION_FAILED",
        actorType,
        actorId: input.actorId,
        entityType: "AI_DECISION_PROPOSAL",
        entityId: proposal.id,
        metadata: { actionType: proposal.actionType, error: executionError },
      });

      return {
        ...failed,
        executed: false,
        verified: false,
        replayed: false,
        error: executionError,
      };
    }

    // Independently re-verify the real state — never trust the
    // execution's own return value alone.
    const verified = await this.verifyAction(input, proposal);

    const updated = await this.prisma.aiDecisionProposal.update({
      where: { id: proposal.id },
      data: {
        status: verified
          ? AiDecisionProposalStatus.EXECUTED
          : AiDecisionProposalStatus.EXECUTION_FAILED,
        decidedAt: new Date(),
        decidedBy: input.actorId,
      },
    });

    await this.recordFeedback(input, AiOutcome.APPROVED, {
      executionResult,
      verified,
    });
    await this.aiMemoryService.recordProposalOutcome({
      tenantId: input.tenantId,
      proposalId: proposal.id,
    });

    await this.auditService.recordEvent({
      tenantId: input.tenantId,
      storeId: input.storeId,
      action: verified
        ? "AI_PROPOSAL_EXECUTED"
        : "AI_PROPOSAL_EXECUTION_VERIFICATION_FAILED",
      actorType,
      actorId: input.actorId,
      entityType: "AI_DECISION_PROPOSAL",
      entityId: proposal.id,
      metadata: {
        actionType: proposal.actionType,
        executionResult: executionResult as object,
        verified,
      },
    });

    return {
      ...updated,
      executed: true,
      verified,
      replayed: false,
      error: undefined,
    };
  }

  async reject(input: RejectProposalInput) {
    const proposal = await this.getProposalForDecision(input);

    const updated = await this.prisma.aiDecisionProposal.update({
      where: { id: proposal.id },
      data: {
        status: AiDecisionProposalStatus.REJECTED,
        decidedAt: new Date(),
        decidedBy: input.actorId,
      },
    });

    await this.recordFeedback(input, AiOutcome.REJECTED);
    await this.aiMemoryService.recordProposalOutcome({
      tenantId: input.tenantId,
      proposalId: proposal.id,
    });

    await this.auditService.recordEvent({
      tenantId: input.tenantId,
      storeId: input.storeId,
      action: "AI_PROPOSAL_REJECTED",
      actorType: AuditActorType.USER,
      actorId: input.actorId,
      entityType: "AI_DECISION_PROPOSAL",
      entityId: proposal.id,
      metadata: { actionType: proposal.actionType, note: input.note },
    });

    return updated;
  }

  /**
   * Dispatches to the right execution primitive for this actionType.
   * RELEASE_ORDER_RESERVATION stays internal (InventoryService,
   * unchanged since Phase 5.4). ADD_ORDER_NOTE is Phase 8's real
   * cross-system write, routed through AiActuationService so the
   * decision layer never talks to Shopify's API shape directly.
   */
  private async executeAction(
    input: ApproveProposalInput,
    proposal: { actionType: string; targetEntityId: string; targetEntityType: string; params: unknown },
  ): Promise<unknown> {
    // Revalidate the target and its current state immediately before
    // execution (safeguard): a proposal approved against a state that has
    // since changed must fail safely here — inside the try/catch that
    // records EXECUTION_FAILED — rather than act on reality it does not
    // match. Renewed authorization means a new investigation/proposal.
    await this.revalidateBeforeExecution(input, proposal);

    if (proposal.actionType === "RELEASE_ORDER_RESERVATION") {
      return this.inventoryService.releaseOrder({
        tenantId: input.tenantId,
        storeId: input.storeId,
        orderId: proposal.targetEntityId,
      });
    }

    if (proposal.actionType === "ADD_ORDER_NOTE") {
      const result = await this.aiActuationService.execute({
        tenantId: input.tenantId,
        storeId: input.storeId,
        actionType: proposal.actionType,
        targetEntityType: proposal.targetEntityType,
        targetEntityId: proposal.targetEntityId,
        params: (proposal.params ?? {}) as Record<string, unknown>,
      });

      if (!result.success) {
        const reason =
          result.raw &&
          typeof result.raw === "object" &&
          "error" in (result.raw as Record<string, unknown>)
            ? String((result.raw as Record<string, unknown>).error)
            : "Actuation failed";

        throw new Error(reason);
      }

      return result;
    }

    throw new Error(`No execution handler registered for actionType ${proposal.actionType}`);
  }

  private async verifyAction(
    input: ApproveProposalInput,
    proposal: { actionType: string; targetEntityId: string; targetEntityType: string; params: unknown },
  ): Promise<boolean> {
    if (proposal.actionType === "RELEASE_ORDER_RESERVATION") {
      // Verify the EXACT intended effects, not merely "zero ACTIVE rows":
      // every reservation of the order must sit RELEASED, and each one
      // must have exactly one RELEASE movement recording the release with
      // the same reservation id and quantity. A silent no-op that left the
      // ledger untouched must never report as verified.
      const activeReservations = await this.prisma.inventoryReservation.count({
        where: {
          tenantId: input.tenantId,
          storeId: input.storeId,
          orderId: proposal.targetEntityId,
          status: InventoryReservationStatus.ACTIVE,
        },
      });

      if (activeReservations !== 0) {
        return false;
      }

      const reservations = await this.prisma.inventoryReservation.findMany({
        where: {
          tenantId: input.tenantId,
          storeId: input.storeId,
          orderId: proposal.targetEntityId,
        },
        select: { id: true, quantity: true, status: true },
      });

      if (
        reservations.length === 0 ||
        reservations.some(
          (reservation) =>
            reservation.status !== InventoryReservationStatus.RELEASED,
        )
      ) {
        return false;
      }

      const releaseMovements =
        await this.prisma.inventoryMovement.findMany({
          where: {
            tenantId: input.tenantId,
            orderId: proposal.targetEntityId,
            type: InventoryMovementType.RELEASE,
          },
          select: { reservationId: true, quantity: true },
        });

      return reservations.every((reservation) =>
        releaseMovements.some(
          (movement) =>
            movement.reservationId === reservation.id &&
            movement.quantity === reservation.quantity,
        ),
      );
    }

    if (proposal.actionType === "ADD_ORDER_NOTE") {
      return this.aiActuationService.verify({
        tenantId: input.tenantId,
        storeId: input.storeId,
        actionType: proposal.actionType,
        targetEntityType: proposal.targetEntityType,
        targetEntityId: proposal.targetEntityId,
        params: (proposal.params ?? {}) as Record<string, unknown>,
      });
    }

    return false;
  }

  private async getProposalForDecision(
    input: AiDecisionContext & { proposalId: string },
  ) {
    const proposal = await this.prisma.aiDecisionProposal.findFirst({
      where: {
        id: input.proposalId,
        tenantId: input.tenantId,
        storeId: input.storeId,
      },
    });

    if (!proposal) {
      throw new NotFoundException(
        "AI decision proposal not found in this tenant/store",
      );
    }

    if (proposal.status !== AiDecisionProposalStatus.PROPOSED) {
      throw new Error(
        `Proposal is not awaiting a decision (current status: ${proposal.status})`,
      );
    }

    return proposal;
  }

  /**
   * Like getProposalForDecision, but EXECUTED/EXECUTION_FAILED proposals
   * are returned for idempotent replay instead of throwing — the caller
   * must not re-execute them. All other decided states still refuse.
   */
  private async getProposalForApproval(
    input: AiDecisionContext & { proposalId: string },
  ) {
    const proposal = await this.prisma.aiDecisionProposal.findFirst({
      where: {
        id: input.proposalId,
        tenantId: input.tenantId,
        storeId: input.storeId,
      },
    });

    if (!proposal) {
      throw new NotFoundException(
        "AI decision proposal not found in this tenant/store",
      );
    }

    if (
      proposal.status === AiDecisionProposalStatus.EXECUTED ||
      proposal.status === AiDecisionProposalStatus.EXECUTION_FAILED
    ) {
      return proposal;
    }

    if (proposal.status !== AiDecisionProposalStatus.PROPOSED) {
      throw new Error(
        `Proposal is not awaiting a decision (current status: ${proposal.status})`,
      );
    }

    return proposal;
  }

  /**
   * The last-moment safety check between authorization and mutation.
   * Throws (surfacing as EXECUTION_FAILED with this message) whenever the
   * world has moved since the proposal was written.
   */
  private async revalidateBeforeExecution(
    input: ApproveProposalInput,
    proposal: {
      actionType: string;
      targetEntityId: string;
      targetEntityType: string;
    },
  ): Promise<void> {
    const order = await this.prisma.order.findFirst({
      where: {
        id: proposal.targetEntityId,
        tenantId: input.tenantId,
        storeId: input.storeId,
      },
      select: { status: true },
    });

    if (!order) {
      throw new Error(
        "Pre-execution revalidation failed: target order no longer exists in this tenant/store; a new investigation is required",
      );
    }

    if (proposal.actionType !== "RELEASE_ORDER_RESERVATION") {
      return;
    }

    const advancedStatuses: OrderStatus[] = [
      OrderStatus.FULFILLING,
      OrderStatus.FULFILLED,
      OrderStatus.CANCELLED,
    ];

    if (advancedStatuses.includes(order.status as OrderStatus)) {
      throw new Error(
        `Pre-execution revalidation failed: the order has advanced to ${order.status} since the proposal was raised; releasing its reservations would be unsafe. A new investigation is required`,
      );
    }

    const reservations = await this.prisma.inventoryReservation.findMany({
      where: { tenantId: input.tenantId, orderId: proposal.targetEntityId },
      select: { status: true },
    });

    const advanced = reservations.filter(
      (reservation) =>
        reservation.status === InventoryReservationStatus.COMMITTED ||
        reservation.status === InventoryReservationStatus.SHIPPED,
    );

    if (advanced.length > 0) {
      throw new Error(
        `Pre-execution revalidation failed: ${advanced.length} reservation(s) have advanced to COMMITTED/SHIPPED since the proposal was raised; releasing them would be unsafe. A new investigation is required`,
      );
    }
  }

  private async recordFeedback(
    input: { proposalId: string; actorId: string; note?: string },
    outcome: AiOutcome,
    observedResult?: object,
  ) {
    return this.prisma.aiOutcomeFeedback.create({
      data: {
        proposalId: input.proposalId,
        outcome,
        actorId: input.actorId,
        note: input.note,
        observedResult,
      },
    });
  }
}

import { describe, expect, it, vi } from "vitest";

import { AiDecisionService } from "./ai-decision.service";

const baseInput = {
  tenantId: "tenant-1",
  storeId: "store-1",
  proposalId: "proposal-1",
  actorId: "user-1",
};

function buildDeps() {
  const prisma = {
    aiDecisionProposal: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    aiOutcomeFeedback: {
      create: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    inventoryReservation: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    inventoryMovement: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    order: {
      findFirst: vi.fn(),
    },
  };

  const auditService = {
    recordEvent: vi.fn().mockResolvedValue({}),
  };

  const inventoryService = {
    releaseOrder: vi.fn(),
  };

  const aiMemoryService = {
    recordProposalOutcome: vi.fn().mockResolvedValue(undefined),
  };

  const aiActuationService = {
    execute: vi.fn(),
    verify: vi.fn(),
  };

  const service = new AiDecisionService(
    prisma as any,
    auditService as any,
    inventoryService as any,
    aiMemoryService as any,
    aiActuationService as any,
  );

  return {
    service,
    prisma,
    auditService,
    inventoryService,
    aiMemoryService,
    aiActuationService,
  };
}

describe("AiDecisionService", () => {
  it("records approval without executing an action with no actuation capability", async () => {
    const { service, prisma, inventoryService } = buildDeps();

    prisma.aiDecisionProposal.findFirst.mockResolvedValue({
      id: "proposal-1",
      status: "PROPOSED",
      actionType: "ESCALATE_TO_HUMAN",
      targetEntityId: "exception-1",
    });
    prisma.aiDecisionProposal.update.mockResolvedValue({
      id: "proposal-1",
      status: "APPROVED",
    });

    const result = await service.approve(baseInput);

    expect(result.executed).toBe(false);
    expect(inventoryService.releaseOrder).not.toHaveBeenCalled();
    expect(prisma.aiDecisionProposal.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "APPROVED" }),
      }),
    );
  });

  it("executes and verifies a RELEASE_ORDER_RESERVATION proposal on approval", async () => {
    const { service, prisma, inventoryService } = buildDeps();

    prisma.aiDecisionProposal.findFirst.mockResolvedValue({
      id: "proposal-1",
      status: "PROPOSED",
      actionType: "RELEASE_ORDER_RESERVATION",
      targetEntityType: "ORDER",
      targetEntityId: "order-1",
    });
    // Pre-execution revalidation: order still FAILED with only ACTIVE rows.
    prisma.order.findFirst.mockResolvedValue({ status: "FAILED" });
    prisma.inventoryReservation.findMany.mockResolvedValue([
      { id: "res-1", quantity: 5, status: "ACTIVE" },
    ]);
    inventoryService.releaseOrder.mockResolvedValue({
      released: true,
      reservationCount: 1,
    });
    // Exact-effect verification: zero ACTIVE, the row is RELEASED, and the
    // ledger carries one RELEASE movement with the same id and quantity.
    prisma.inventoryReservation.count.mockResolvedValue(0);
    prisma.inventoryReservation.findMany.mockResolvedValue([
      { id: "res-1", quantity: 5, status: "RELEASED" },
    ]);
    prisma.inventoryMovement.findMany.mockResolvedValue([
      { reservationId: "res-1", quantity: 5 },
    ]);
    prisma.aiDecisionProposal.update.mockResolvedValue({
      id: "proposal-1",
      status: "EXECUTED",
    });

    const result = await service.approve(baseInput);

    expect(inventoryService.releaseOrder).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      storeId: "store-1",
      orderId: "order-1",
    });
    expect(result.executed).toBe(true);
    expect(result.verified).toBe(true);
  });

  it("refuses RELEASE_ORDER_RESERVATION without explicit human approval", async () => {
    const { service, prisma, inventoryService } = buildDeps();

    prisma.aiDecisionProposal.findFirst.mockResolvedValue({
      id: "proposal-1",
      status: "PROPOSED",
      actionType: "RELEASE_ORDER_RESERVATION",
      targetEntityType: "ORDER",
      targetEntityId: "order-1",
    });

    await expect(
      service.approve({ ...baseInput, actorType: "SYSTEM" as never }),
    ).rejects.toThrow(/human approval/i);

    expect(inventoryService.releaseOrder).not.toHaveBeenCalled();
    expect(prisma.aiDecisionProposal.update).not.toHaveBeenCalled();
  });

  it("replays an already-EXECUTED proposal idempotently without re-executing", async () => {
    const { service, prisma, inventoryService } = buildDeps();

    prisma.aiDecisionProposal.findFirst.mockResolvedValue({
      id: "proposal-1",
      status: "EXECUTED",
      actionType: "RELEASE_ORDER_RESERVATION",
      targetEntityType: "ORDER",
      targetEntityId: "order-1",
    });

    const result = await service.approve(baseInput);

    expect(result.replayed).toBe(true);
    expect(result.executed).toBe(true);
    expect(result.verified).toBe(true);
    expect(inventoryService.releaseOrder).not.toHaveBeenCalled();
    expect(prisma.aiDecisionProposal.update).not.toHaveBeenCalled();
  });

  it("replays an EXECUTION_FAILED proposal idempotently and requires a new proposal for any retry", async () => {
    const { service, prisma, inventoryService } = buildDeps();

    prisma.aiDecisionProposal.findFirst.mockResolvedValue({
      id: "proposal-1",
      status: "EXECUTION_FAILED",
      actionType: "RELEASE_ORDER_RESERVATION",
      targetEntityType: "ORDER",
      targetEntityId: "order-1",
    });
    prisma.aiOutcomeFeedback.findFirst.mockResolvedValue({
      observedResult: { executionError: "Pre-execution revalidation failed: ..." },
    });

    const result = await service.approve(baseInput);

    expect(result.replayed).toBe(true);
    expect(result.executed).toBe(false);
    expect(result.verified).toBe(false);
    expect(String(result.error)).toContain("revalidation");
    expect(inventoryService.releaseOrder).not.toHaveBeenCalled();
    expect(prisma.aiDecisionProposal.update).not.toHaveBeenCalled();
  });

  it("fails safely at execution when the order has advanced since the proposal", async () => {
    const { service, prisma, inventoryService } = buildDeps();

    prisma.aiDecisionProposal.findFirst.mockResolvedValue({
      id: "proposal-1",
      status: "PROPOSED",
      actionType: "RELEASE_ORDER_RESERVATION",
      targetEntityType: "ORDER",
      targetEntityId: "order-1",
    });
    prisma.order.findFirst.mockResolvedValue({ status: "FULFILLING" });
    prisma.aiDecisionProposal.update.mockResolvedValue({
      id: "proposal-1",
      status: "EXECUTION_FAILED",
    });

    const result = await service.approve(baseInput);

    expect(result.executed).toBe(false);
    expect(result.verified).toBe(false);
    expect(String(result.error)).toContain("revalidation");
    expect(inventoryService.releaseOrder).not.toHaveBeenCalled();
    expect(prisma.aiDecisionProposal.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "EXECUTION_FAILED" }),
      }),
    );
  });

  it("fails safely at execution when reservations have advanced to COMMITTED/SHIPPED", async () => {
    const { service, prisma, inventoryService } = buildDeps();

    prisma.aiDecisionProposal.findFirst.mockResolvedValue({
      id: "proposal-1",
      status: "PROPOSED",
      actionType: "RELEASE_ORDER_RESERVATION",
      targetEntityType: "ORDER",
      targetEntityId: "order-1",
    });
    prisma.order.findFirst.mockResolvedValue({ status: "FAILED" });
    prisma.inventoryReservation.findMany.mockResolvedValue([
      { status: "COMMITTED" },
    ]);
    prisma.aiDecisionProposal.update.mockResolvedValue({
      id: "proposal-1",
      status: "EXECUTION_FAILED",
    });

    const result = await service.approve(baseInput);

    expect(result.executed).toBe(false);
    expect(String(result.error)).toContain("COMMITTED");
    expect(inventoryService.releaseOrder).not.toHaveBeenCalled();
  });

  it("fails verification when the release ledger has no matching RELEASE movement", async () => {
    const { service, prisma, inventoryService, auditService } = buildDeps();

    prisma.aiDecisionProposal.findFirst.mockResolvedValue({
      id: "proposal-1",
      status: "PROPOSED",
      actionType: "RELEASE_ORDER_RESERVATION",
      targetEntityType: "ORDER",
      targetEntityId: "order-1",
    });
    prisma.order.findFirst.mockResolvedValue({ status: "FAILED" });
    prisma.inventoryReservation.findMany.mockResolvedValue([
      { id: "res-1", quantity: 5, status: "ACTIVE" },
    ]);
    inventoryService.releaseOrder.mockResolvedValue({ released: true });
    // Zero ACTIVE rows and RELEASED rows — but the movement ledger is
    // empty: the exact intended effects cannot be confirmed.
    prisma.inventoryReservation.count.mockResolvedValue(0);
    prisma.inventoryReservation.findMany.mockResolvedValue([
      { id: "res-1", quantity: 5, status: "RELEASED" },
    ]);
    prisma.inventoryMovement.findMany.mockResolvedValue([]);
    prisma.aiDecisionProposal.update.mockResolvedValue({
      id: "proposal-1",
      status: "EXECUTION_FAILED",
    });

    const result = await service.approve(baseInput);

    expect(result.executed).toBe(true);
    expect(result.verified).toBe(false);
    expect(prisma.aiDecisionProposal.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "EXECUTION_FAILED" }),
      }),
    );
    expect(auditService.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "AI_PROPOSAL_EXECUTION_VERIFICATION_FAILED",
      }),
    );
  });

  it("marks execution as failed when post-execution verification finds active reservations remain", async () => {
    const { service, prisma, inventoryService } = buildDeps();

    prisma.aiDecisionProposal.findFirst.mockResolvedValue({
      id: "proposal-1",
      status: "PROPOSED",
      actionType: "RELEASE_ORDER_RESERVATION",
      targetEntityType: "ORDER",
      targetEntityId: "order-1",
    });
    prisma.order.findFirst.mockResolvedValue({ status: "FAILED" });
    prisma.inventoryReservation.findMany.mockResolvedValue([
      { status: "ACTIVE" },
    ]);
    inventoryService.releaseOrder.mockResolvedValue({ released: true });
    prisma.inventoryReservation.count.mockResolvedValue(2);
    prisma.aiDecisionProposal.update.mockResolvedValue({
      id: "proposal-1",
      status: "EXECUTION_FAILED",
    });

    const result = await service.approve(baseInput);

    expect(result.executed).toBe(true);
    expect(result.verified).toBe(false);
    expect(prisma.aiDecisionProposal.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "EXECUTION_FAILED" }),
      }),
    );
  });

  it("rejects a proposal without attempting execution", async () => {
    const { service, prisma, inventoryService } = buildDeps();

    prisma.aiDecisionProposal.findFirst.mockResolvedValue({
      id: "proposal-1",
      status: "PROPOSED",
      actionType: "RELEASE_ORDER_RESERVATION",
      targetEntityType: "ORDER",
      targetEntityId: "order-1",
    });
    prisma.aiDecisionProposal.update.mockResolvedValue({
      id: "proposal-1",
      status: "REJECTED",
    });

    const result = await service.reject(baseInput);

    expect(result.status).toBe("REJECTED");
    expect(inventoryService.releaseOrder).not.toHaveBeenCalled();
  });

  it("refuses to decide on a proposal that is not in PROPOSED status", async () => {
    const { service, prisma } = buildDeps();

    prisma.aiDecisionProposal.findFirst.mockResolvedValue({
      id: "proposal-1",
      status: "APPROVED",
      actionType: "ESCALATE_TO_HUMAN",
      targetEntityId: "exception-1",
    });

    await expect(service.approve(baseInput)).rejects.toThrow(
      /not awaiting a decision/i,
    );
  });

  it("throws when the proposal does not exist in this tenant/store", async () => {
    const { service, prisma } = buildDeps();

    prisma.aiDecisionProposal.findFirst.mockResolvedValue(null);

    await expect(service.approve(baseInput)).rejects.toThrow(/not found/i);
  });
});

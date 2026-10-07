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
    },
    inventoryReservation: {
      count: vi.fn(),
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
    inventoryService.releaseOrder.mockResolvedValue({
      released: true,
      reservationCount: 1,
    });
    prisma.inventoryReservation.count.mockResolvedValue(0);
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

  it("marks execution as failed when post-execution verification finds active reservations remain", async () => {
    const { service, prisma, inventoryService } = buildDeps();

    prisma.aiDecisionProposal.findFirst.mockResolvedValue({
      id: "proposal-1",
      status: "PROPOSED",
      actionType: "RELEASE_ORDER_RESERVATION",
      targetEntityType: "ORDER",
      targetEntityId: "order-1",
    });
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

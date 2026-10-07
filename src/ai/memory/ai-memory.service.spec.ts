import { describe, expect, it, vi } from "vitest";

import { AiMemoryService } from "./ai-memory.service";

function buildDeps() {
  const prisma = {
    aiDecisionProposal: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    aiMemoryFact: {
      findFirst: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: "fact-new" }),
      findMany: vi.fn(),
    },
  };

  return { service: new AiMemoryService(prisma as any), prisma };
}

describe("AiMemoryService", () => {
  it("does nothing if the proposal doesn't exist", async () => {
    const { service, prisma } = buildDeps();

    prisma.aiDecisionProposal.findUnique.mockResolvedValue(null);

    await service.recordProposalOutcome({
      tenantId: "tenant-1",
      proposalId: "missing",
    });

    expect(prisma.aiMemoryFact.create).not.toHaveBeenCalled();
  });

  it("does nothing if there is no decided history yet for this action/category", async () => {
    const { service, prisma } = buildDeps();

    prisma.aiDecisionProposal.findUnique.mockResolvedValue({
      id: "proposal-1",
      actionType: "RELEASE_ORDER_RESERVATION",
      status: "APPROVED",
      investigationId: "investigation-1",
      exception: { category: "ORDER_INTEGRITY" },
    });
    prisma.aiDecisionProposal.findMany.mockResolvedValue([]);

    await service.recordProposalOutcome({
      tenantId: "tenant-1",
      proposalId: "proposal-1",
    });

    expect(prisma.aiMemoryFact.create).not.toHaveBeenCalled();
  });

  it("computes confidence from real approve/reject counts and supersedes the previous fact", async () => {
    const { service, prisma } = buildDeps();

    prisma.aiDecisionProposal.findUnique.mockResolvedValue({
      id: "proposal-3",
      actionType: "RELEASE_ORDER_RESERVATION",
      status: "EXECUTED",
      investigationId: "investigation-3",
      exception: { category: "ORDER_INTEGRITY" },
    });

    prisma.aiDecisionProposal.findMany.mockResolvedValue([
      { status: "EXECUTED" },
      { status: "APPROVED" },
      { status: "REJECTED" },
    ]);

    prisma.aiMemoryFact.findFirst.mockResolvedValue({ id: "fact-old" });

    await service.recordProposalOutcome({
      tenantId: "tenant-1",
      proposalId: "proposal-3",
    });

    expect(prisma.aiMemoryFact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: "tenant-1",
          category: "ORDER_INTEGRITY:RELEASE_ORDER_RESERVATION",
          confidence: 2 / 3,
          supersedesId: "fact-old",
        }),
      }),
    );
  });

  it("returns only the most recent fact per category key", async () => {
    const { service, prisma } = buildDeps();

    prisma.aiMemoryFact.findMany.mockResolvedValue([
      { category: "A:X", createdAt: new Date("2026-01-02"), fact: "newest" },
      { category: "A:X", createdAt: new Date("2026-01-01"), fact: "older" },
      { category: "B:Y", createdAt: new Date("2026-01-01"), fact: "other" },
    ]);

    const facts = await service.getCurrentFacts({ tenantId: "tenant-1" });

    expect(facts).toHaveLength(2);
    expect(facts.find((f) => f.category === "A:X")?.fact).toBe("newest");
  });
});

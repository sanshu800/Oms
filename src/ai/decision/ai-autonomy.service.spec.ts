import { describe, expect, it, vi } from "vitest";

import { AiAutonomyService } from "./ai-autonomy.service";

const baseInput = {
  tenantId: "tenant-1",
  storeId: "store-1",
  proposalId: "proposal-1",
};

function buildDeps() {
  const prisma = {
    aiDecisionProposal: {
      findFirst: vi.fn(),
    },
  };

  const auditService = {
    recordEvent: vi.fn().mockResolvedValue({}),
  };

  const policyService = {
    getPolicy: vi.fn(),
    countRecentAutoExecutions: vi.fn(),
  };

  const aiDecisionService = {
    approve: vi.fn().mockResolvedValue({ status: "EXECUTED" }),
  };

  const service = new AiAutonomyService(
    prisma as any,
    auditService as any,
    policyService as any,
    aiDecisionService as any,
  );

  return { service, prisma, auditService, policyService, aiDecisionService };
}

const lowRiskProposal = {
  id: "proposal-1",
  status: "PROPOSED",
  riskTier: "LOW",
  confidence: 0.95,
  actionType: "ADD_ORDER_NOTE",
};

const enabledPolicy = {
  autonomyLevel: "AUTO_BELOW_THRESHOLD",
  confidenceThreshold: 0.9,
  maxActionsPerHour: 5,
  enabled: true,
};

describe("AiAutonomyService", () => {
  it("auto-executes a LOW-risk proposal that clears an enabled, matching policy", async () => {
    const { service, prisma, policyService, aiDecisionService } = buildDeps();

    prisma.aiDecisionProposal.findFirst.mockResolvedValue(lowRiskProposal);
    policyService.getPolicy.mockResolvedValue(enabledPolicy);
    policyService.countRecentAutoExecutions.mockResolvedValue(0);

    await service.maybeAutoExecute(baseInput);

    expect(aiDecisionService.approve).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId: "proposal-1",
        actorType: "SYSTEM",
      }),
    );
  });

  it("never auto-executes RELEASE_ORDER_RESERVATION even under a matching, enabled policy (human-only)", async () => {
    const { service, prisma, policyService, aiDecisionService, auditService } =
      buildDeps();

    prisma.aiDecisionProposal.findFirst.mockResolvedValue({
      ...lowRiskProposal,
      actionType: "RELEASE_ORDER_RESERVATION",
    });
    policyService.getPolicy.mockResolvedValue(enabledPolicy);
    policyService.countRecentAutoExecutions.mockResolvedValue(0);

    await service.maybeAutoExecute(baseInput);

    expect(aiDecisionService.approve).not.toHaveBeenCalled();
    expect(auditService.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "AI_AUTONOMY_HUMAN_ONLY_ACTION" }),
    );
  });

  it("never auto-executes a MEDIUM or HIGH risk proposal regardless of policy", async () => {
    const { service, prisma, policyService, aiDecisionService } = buildDeps();

    prisma.aiDecisionProposal.findFirst.mockResolvedValue({
      ...lowRiskProposal,
      riskTier: "HIGH",
    });
    policyService.getPolicy.mockResolvedValue(enabledPolicy);

    await service.maybeAutoExecute(baseInput);

    expect(aiDecisionService.approve).not.toHaveBeenCalled();
  });

  it("does nothing when no policy exists for this tenant/actionType", async () => {
    const { service, prisma, policyService, aiDecisionService } = buildDeps();

    prisma.aiDecisionProposal.findFirst.mockResolvedValue(lowRiskProposal);
    policyService.getPolicy.mockResolvedValue(null);

    await service.maybeAutoExecute(baseInput);

    expect(aiDecisionService.approve).not.toHaveBeenCalled();
  });

  it("does nothing when the policy is disabled", async () => {
    const { service, prisma, policyService, aiDecisionService } = buildDeps();

    prisma.aiDecisionProposal.findFirst.mockResolvedValue(lowRiskProposal);
    policyService.getPolicy.mockResolvedValue({ ...enabledPolicy, enabled: false });

    await service.maybeAutoExecute(baseInput);

    expect(aiDecisionService.approve).not.toHaveBeenCalled();
  });

  it("does nothing when confidence is below the policy's threshold", async () => {
    const { service, prisma, policyService, aiDecisionService } = buildDeps();

    prisma.aiDecisionProposal.findFirst.mockResolvedValue({
      ...lowRiskProposal,
      confidence: 0.5,
    });
    policyService.getPolicy.mockResolvedValue(enabledPolicy);

    await service.maybeAutoExecute(baseInput);

    expect(aiDecisionService.approve).not.toHaveBeenCalled();
  });

  it("throttles and does not execute when the hourly blast-radius limit is reached", async () => {
    const { service, prisma, policyService, auditService, aiDecisionService } =
      buildDeps();

    prisma.aiDecisionProposal.findFirst.mockResolvedValue(lowRiskProposal);
    policyService.getPolicy.mockResolvedValue(enabledPolicy);
    policyService.countRecentAutoExecutions.mockResolvedValue(5);

    await service.maybeAutoExecute(baseInput);

    expect(aiDecisionService.approve).not.toHaveBeenCalled();
    expect(auditService.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "AI_AUTONOMY_THROTTLED" }),
    );
  });

  it("does nothing when the proposal is not in PROPOSED status", async () => {
    const { service, prisma, aiDecisionService } = buildDeps();

    prisma.aiDecisionProposal.findFirst.mockResolvedValue({
      ...lowRiskProposal,
      status: "APPROVED",
    });

    await service.maybeAutoExecute(baseInput);

    expect(aiDecisionService.approve).not.toHaveBeenCalled();
  });
});

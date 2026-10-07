import { describe, expect, it, vi } from "vitest";

import { AiInvestigationService } from "./ai-investigation.service";
import { SUBMIT_DECISION_PROPOSAL_TOOL } from "./ai-decision-proposal.schema";

const baseInput = {
  tenantId: "tenant-1",
  storeId: "store-1",
  exceptionId: "exception-1",
};

const validProposalArgs = {
  actionType: "ESCALATE_TO_HUMAN",
  targetEntityType: "OPERATIONAL_EXCEPTION",
  targetEntityId: "exception-1",
  confidence: 0.8,
  basis: "HEURISTIC",
  riskTier: "MEDIUM",
  reasoningSummary: "Test reasoning",
  evidenceRefs: [],
};

function buildDeps(overrides: {
  configValues?: Record<string, number | string>;
  createChatCompletion?: () => Promise<any>;
} = {}) {
  const configValues: Record<string, number | string> = {
    AI_INVESTIGATION_MAX_TOOL_CALLS: 5,
    AI_INVESTIGATION_TIMEOUT_MS: 5000,
    AI_INVESTIGATION_MAX_TOKENS: 20000,
    GROQ_MODEL: "test-model",
    ...overrides.configValues,
  };

  const prisma = {
    aiInvestigation: {
      create: vi.fn().mockResolvedValue({ id: "investigation-1" }),
      update: vi.fn().mockResolvedValue({}),
    },
    aiToolCall: {
      create: vi.fn().mockResolvedValue({}),
    },
    aiDecisionProposal: {
      create: vi.fn().mockResolvedValue({ id: "proposal-1" }),
    },
  };

  const exceptionService = {
    getById: vi.fn().mockResolvedValue({ id: "exception-1" }),
  };

  const auditService = {
    recordEvent: vi.fn().mockResolvedValue({}),
  };

  const aiToolsService = {
    getToolDefinitions: vi.fn().mockReturnValue([]),
    execute: vi.fn().mockResolvedValue({ ok: true }),
  };

  const aiAutonomyService = {
    maybeAutoExecute: vi.fn().mockResolvedValue(undefined),
  };

  const config = {
    get: (key: string) => configValues[key],
  };

  const llmClient = {
    createChatCompletion:
      overrides.createChatCompletion ??
      vi.fn().mockResolvedValue({
        message: { role: "assistant", content: "no tool calls" },
        tokensUsed: 10,
      }),
  };

  const service = new AiInvestigationService(
    prisma as any,
    exceptionService as any,
    auditService as any,
    aiToolsService as any,
    aiAutonomyService as any,
    config as any,
    llmClient as any,
  );

  return { service, prisma, auditService, llmClient, aiAutonomyService };
}

describe("AiInvestigationService", () => {
  it("persists a proposal when the model submits a valid one", async () => {
    const createChatCompletion = vi.fn().mockResolvedValue({
      message: {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "call-1",
            name: SUBMIT_DECISION_PROPOSAL_TOOL,
            arguments: validProposalArgs,
          },
        ],
      },
      tokensUsed: 50,
    });

    const { service, prisma } = buildDeps({ createChatCompletion });

    const result = await service.investigate(baseInput);

    expect(result.status).toBe("COMPLETED");
    expect(result.proposalId).toBe("proposal-1");
    expect(prisma.aiDecisionProposal.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actionType: "ESCALATE_TO_HUMAN",
          riskTier: "MEDIUM",
        }),
      }),
    );
  });

  it("fails after too many invalid proposal submissions", async () => {
    const createChatCompletion = vi.fn().mockResolvedValue({
      message: {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "call-1",
            name: SUBMIT_DECISION_PROPOSAL_TOOL,
            arguments: { actionType: "MISSING_REQUIRED_FIELDS" },
          },
        ],
      },
      tokensUsed: 10,
    });

    const { service } = buildDeps({ createChatCompletion });

    const result = await service.investigate(baseInput);

    expect(result.status).toBe("FAILED");
    expect(result.error).toMatch(/invalid decision proposal/i);
  });

  it("fails when the tool-call budget is exhausted without a conclusion", async () => {
    const createChatCompletion = vi.fn().mockResolvedValue({
      message: { role: "assistant", content: "still thinking" },
      tokensUsed: 5,
    });

    const { service } = buildDeps({
      createChatCompletion,
      configValues: { AI_INVESTIGATION_MAX_TOOL_CALLS: 3 },
    });

    const result = await service.investigate(baseInput);

    expect(result.status).toBe("FAILED");
    expect(result.error).toMatch(/without a valid submit_decision_proposal/i);
  });

  it("fails when the token budget is exceeded", async () => {
    const createChatCompletion = vi.fn().mockResolvedValue({
      message: { role: "assistant", content: null, toolCalls: [] },
      tokensUsed: 999999,
    });

    const { service } = buildDeps({
      createChatCompletion,
      configValues: { AI_INVESTIGATION_MAX_TOKENS: 100 },
    });

    const result = await service.investigate(baseInput);

    expect(result.status).toBe("FAILED");
    expect(result.error).toMatch(/token budget/i);
  });
});

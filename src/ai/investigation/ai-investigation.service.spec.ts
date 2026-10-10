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
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    aiToolCall: {
      create: vi.fn().mockResolvedValue({}),
    },
    aiDecisionProposal: {
      create: vi.fn().mockResolvedValue({ id: "proposal-1" }),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(prisma),
    ),
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

  // ---- D2: evidence provenance (grounding) at proposal time ----

  it("rejects a proposal whose target never appeared in retrieved evidence", async () => {
    const createChatCompletion = vi.fn().mockResolvedValue({
      message: {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "call-1",
            name: SUBMIT_DECISION_PROPOSAL_TOOL,
            arguments: {
              actionType: "RELEASE_ORDER_RESERVATION",
              targetEntityType: "ORDER",
              targetEntityId: "order-guessed-by-the-model",
              confidence: 0.9,
              basis: "HEURISTIC",
              riskTier: "HIGH",
              reasoningSummary: "Looks like a stuck reservation",
              evidenceRefs: [],
            },
          },
        ],
      },
      tokensUsed: 10,
    });

    const { service, prisma } = buildDeps({ createChatCompletion });

    const result = await service.investigate(baseInput);

    expect(result.status).toBe("FAILED");
    expect(result.error).toMatch(/did not correct/i);
    expect(result.error).toMatch(/targetEntityId/);
    expect(prisma.aiDecisionProposal.create).not.toHaveBeenCalled();
  });

  it("rejects a proposal whose evidenceRef never appeared in retrieved evidence", async () => {
    const createChatCompletion = vi.fn().mockResolvedValue({
      message: {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "call-1",
            name: SUBMIT_DECISION_PROPOSAL_TOOL,
            arguments: {
              ...validProposalArgs,
              evidenceRefs: ["order-fabricated-ref"],
            },
          },
        ],
      },
      tokensUsed: 10,
    });

    const { service, prisma } = buildDeps({ createChatCompletion });

    const result = await service.investigate(baseInput);

    expect(result.status).toBe("FAILED");
    expect(result.error).toMatch(/evidenceRef/);
    expect(prisma.aiDecisionProposal.create).not.toHaveBeenCalled();
  });

  it("grounds targets against real tool output (get_exception_context returning the order)", async () => {
    const aiToolsExecute = vi
      .fn()
      .mockResolvedValue({ exception: { id: "exception-1" }, order: { id: "order-1" } });

    const createChatCompletion = vi
      .fn()
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "call-1",
              name: "get_exception_context",
              arguments: { exceptionId: "exception-1" },
            },
          ],
        },
        tokensUsed: 10,
      })
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "call-2",
              name: SUBMIT_DECISION_PROPOSAL_TOOL,
              arguments: {
                actionType: "RELEASE_ORDER_RESERVATION",
                targetEntityType: "ORDER",
                targetEntityId: "order-1",
                confidence: 0.9,
                basis: "HEURISTIC",
                riskTier: "HIGH",
                reasoningSummary: "Grounded in get_exception_context output",
                evidenceRefs: ["order-1"],
              },
            },
          ],
        },
        tokensUsed: 10,
      });

    const configValues = {
      AI_INVESTIGATION_MAX_TOOL_CALLS: 5,
      AI_INVESTIGATION_TIMEOUT_MS: 5000,
      AI_INVESTIGATION_MAX_TOKENS: 20000,
      GROQ_MODEL: "test-model",
    };

    const prisma = {
      aiInvestigation: {
        create: vi.fn().mockResolvedValue({ id: "investigation-1" }),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      aiToolCall: { create: vi.fn().mockResolvedValue({}) },
      aiDecisionProposal: { create: vi.fn().mockResolvedValue({ id: "proposal-1" }) },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    };

    const service = new AiInvestigationService(
      prisma as any,
      { getById: vi.fn().mockResolvedValue({ id: "exception-1" }) } as any,
      { recordEvent: vi.fn().mockResolvedValue({}) } as any,
      {
        getToolDefinitions: vi.fn().mockReturnValue([{ name: "get_exception_context" }]),
        execute: aiToolsExecute,
      } as any,
      { maybeAutoExecute: vi.fn().mockResolvedValue(undefined) } as any,
      { get: (key: string) => configValues[key as keyof typeof configValues] } as any,
      { createChatCompletion } as any,
    );

    const result = await service.investigate(baseInput);

    expect(result.status).toBe("COMPLETED");
    expect(aiToolsExecute).toHaveBeenCalledTimes(1);
    expect(prisma.aiDecisionProposal.create).toHaveBeenCalledTimes(1);
  });

  // ---- D1: timeout cancellation, single row, no contradictory publish ----

  it("timeout finalizes the ONE investigation row and never publishes a late proposal", async () => {
    let resolveLlm: (value: unknown) => void = () => undefined;

    const createChatCompletion = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLlm = resolve;
        }),
    );

    const { service, prisma, aiAutonomyService } = buildDeps({
      createChatCompletion,
      configValues: { AI_INVESTIGATION_TIMEOUT_MS: 20 },
    });

    // The guarded claim: FAILED transition succeeds once (RUNNING→FAILED);
    // any later COMPLETED claim finds the row already terminal.
    let terminal = false;
    (prisma.aiInvestigation.updateMany as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ data }: { data: { status: string } }) => {
        if (data.status === "COMPLETED") {
          return { count: terminal ? 0 : 1 };
        }
        terminal = true;
        return { count: 1 };
      },
    );

    const result = await service.investigate(baseInput);

    expect(result.status).toBe("FAILED");
    expect(result.error).toMatch(/timed out/i);
    // Exactly one row, finalized as FAILED — no second row from
    // failWithoutInvestigationRow.
    expect(prisma.aiInvestigation.create).toHaveBeenCalledTimes(1);
    expect(prisma.aiInvestigation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "FAILED" }),
      }),
    );

    // Now let the orphaned run finish with a valid submit: it must NOT
    // publish a proposal or trigger autonomy.
    resolveLlm({
      message: {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "call-late",
            name: SUBMIT_DECISION_PROPOSAL_TOOL,
            arguments: validProposalArgs,
          },
        ],
      },
      tokensUsed: 10,
    });

    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(prisma.aiDecisionProposal.create).not.toHaveBeenCalled();
    expect(aiAutonomyService.maybeAutoExecute).not.toHaveBeenCalled();
  });

  it("clears the timeout timer after a successful run (no leaked timers)", async () => {
    vi.useFakeTimers();

    try {
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
        tokensUsed: 10,
      });

      const { service } = buildDeps({ createChatCompletion });

      const result = await service.investigate(baseInput);

      expect(result.status).toBe("COMPLETED");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

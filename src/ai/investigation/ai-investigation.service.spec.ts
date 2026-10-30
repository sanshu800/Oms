import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

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
  aiToolsExecute?: ReturnType<typeof vi.fn>;
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
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    aiToolCall: {
      create: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    aiDecisionProposal: {
      create: vi.fn().mockResolvedValue({ id: "proposal-1" }),
      findFirst: vi.fn().mockResolvedValue(null),
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
    getToolDefinitions: vi.fn().mockReturnValue([
      { name: "get_order_detail" },
    ]),
    execute:
      overrides.aiToolsExecute ?? vi.fn().mockResolvedValue({ ok: true }),
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

  return {
    service,
    prisma,
    auditService,
    llmClient,
    aiAutonomyService,
    aiToolsService,
  };
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

  // ---- D2 + reservation-holder evidence (Phase 1C) ----

  it("grounds a proposal on a reservation holder returned by get_inventory_truth", async () => {
    const aiToolsExecute = vi.fn().mockResolvedValue({
      inventoryTruth: {
        inventoryItemId: "item-1",
        sku: "sku-managed-1",
        availableQty: 2,
        reservedQty: 5,
        committedQty: 0,
        reservations: [
          { orderId: "order-holder-1", quantity: 5, status: "ACTIVE" },
        ],
      },
    });

    const createChatCompletion = vi
      .fn()
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "call-1",
              name: "get_inventory_truth",
              arguments: { sku: "sku-managed-1" },
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
                targetEntityId: "order-holder-1",
                confidence: 0.9,
                basis: "TENANT_HISTORY",
                riskTier: "HIGH",
                reasoningSummary:
                  "order-holder-1 holds the 5 reserved units blocking the new order.",
                evidenceRefs: ["order-holder-1"],
              },
            },
          ],
        },
        tokensUsed: 10,
      });

    const { service, prisma } = buildDeps({
      createChatCompletion,
      aiToolsExecute,
    });

    const result = await service.investigate(baseInput);

    expect(result.status).toBe("COMPLETED");
    expect(prisma.aiDecisionProposal.create).toHaveBeenCalledTimes(1);
    expect(prisma.aiDecisionProposal.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ targetEntityId: "order-holder-1" }),
      }),
    );
  });

  it("cannot ground an invented or unreturned reservation holder", async () => {
    // The tool exposes order-holder-1 only. A model that targets a
    // different id (invented, or belonging to another tenant/store it
    // never observed) must be rejected — the id appears nowhere in
    // successful tool output.
    const aiToolsExecute = vi.fn().mockResolvedValue({
      inventoryTruth: {
        inventoryItemId: "item-1",
        sku: "sku-managed-1",
        availableQty: 2,
        reservedQty: 5,
        committedQty: 0,
        reservations: [
          { orderId: "order-holder-1", quantity: 5, status: "ACTIVE" },
        ],
      },
    });

    const createChatCompletion = vi
      .fn()
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "call-1",
              name: "get_inventory_truth",
              arguments: { sku: "sku-managed-1" },
            },
          ],
        },
        tokensUsed: 10,
      })
      .mockResolvedValue({
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
                targetEntityId: "order-unreturned-2",
                confidence: 0.9,
                basis: "TENANT_HISTORY",
                riskTier: "HIGH",
                reasoningSummary:
                  "Releasing the reservation I believe is holding the stock.",
                evidenceRefs: ["order-unreturned-2"],
              },
            },
          ],
        },
        tokensUsed: 10,
      });

    const { service, prisma } = buildDeps({
      createChatCompletion,
      aiToolsExecute,
    });

    const result = await service.investigate(baseInput);

    expect(result.status).toBe("FAILED");
    expect(result.error).toMatch(/targetEntityId/);
    expect(prisma.aiDecisionProposal.create).not.toHaveBeenCalled();
  });

  it("cannot ground a cross-store reservation holder implied only by unexplained quantity", async () => {
    // Store-scoped evidence: the authorized store holds order-holder-1;
    // unexplainedReservedQty reveals that MORE stock is held outside the
    // scope (e.g. another store) without naming the holder. A model that
    // names that unseen holder must be rejected — the id exists nowhere in
    // successful tool output, and cross-store rows are not authorized for
    // this investigation.
    const aiToolsExecute = vi.fn().mockResolvedValue({
      inventoryTruth: {
        inventoryItemId: "item-1",
        sku: "sku-managed-1",
        availableQty: 0,
        reservedQty: 8,
        committedQty: 0,
        reservationsScope: "STORE",
        reservations: [
          { orderId: "order-holder-1", quantity: 2, status: "ACTIVE" },
        ],
        unexplainedReservedQty: 6,
        unexplainedCommittedQty: 0,
      },
    });

    const createChatCompletion = vi
      .fn()
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "call-1",
              name: "get_inventory_truth",
              arguments: { sku: "sku-managed-1" },
            },
          ],
        },
        tokensUsed: 10,
      })
      .mockResolvedValue({
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
                targetEntityId: "order-other-store-9",
                confidence: 0.9,
                basis: "TENANT_HISTORY",
                riskTier: "HIGH",
                reasoningSummary:
                  "The unexplained 6 reserved units must be order-other-store-9; releasing it.",
                evidenceRefs: ["order-other-store-9"],
              },
            },
          ],
        },
        tokensUsed: 10,
      });

    const { service, prisma } = buildDeps({
      createChatCompletion,
      aiToolsExecute,
    });

    const result = await service.investigate(baseInput);

    expect(result.status).toBe("FAILED");
    expect(result.error).toMatch(/targetEntityId/);
    expect(prisma.aiDecisionProposal.create).not.toHaveBeenCalled();
  });

  // ---- D2 adversarial provenance regressions ----

  it("rejects a target echoed only in tool ARGUMENTS (input-echo attack)", async () => {
    // The model asks for `order-echo-1`; the tool returns a DIFFERENT
    // order. Tool arguments are model claims — they must not ground.
    const aiToolsExecute = vi
      .fn()
      .mockResolvedValue({ order: { id: "order-real-answer", state: "HELD" } });

    const createChatCompletion = vi
      .fn()
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "call-1",
              name: "get_order_detail",
              arguments: { orderId: "order-echo-1" },
            },
          ],
        },
        tokensUsed: 10,
      })
      .mockResolvedValue({
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
                targetEntityId: "order-echo-1",
                confidence: 0.9,
                basis: "HEURISTIC",
                riskTier: "HIGH",
                reasoningSummary: "Releasing the order I asked about.",
                evidenceRefs: ["order-echo-1"],
              },
            },
          ],
        },
        tokensUsed: 10,
      });

    const { service, prisma } = buildDeps({
      createChatCompletion,
      aiToolsExecute,
    });

    const result = await service.investigate(baseInput);

    expect(result.status).toBe("FAILED");
    expect(result.error).toMatch(/targetEntityId/);
    expect(prisma.aiDecisionProposal.create).not.toHaveBeenCalled();
  });

  it("rejects ids that appear only in error output (failed-output attack)", async () => {
    // The tool FAILED and its error message mentions a plausible id.
    // Error payloads are not evidence.
    const aiToolsExecute = vi
      .fn()
      .mockResolvedValue({ error: "Order order-err-1 was not found" });

    const createChatCompletion = vi
      .fn()
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "call-1",
              name: "get_order_detail",
              arguments: { orderId: "order-anything" },
            },
          ],
        },
        tokensUsed: 10,
      })
      .mockResolvedValue({
        message: {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "call-2",
              name: SUBMIT_DECISION_PROPOSAL_TOOL,
              arguments: {
                actionType: "ADD_ORDER_NOTE",
                targetEntityType: "ORDER",
                targetEntityId: "order-err-1",
                confidence: 0.8,
                basis: "TENANT_HISTORY",
                riskTier: "LOW",
                reasoningSummary: "The tool said order-err-1 exists.",
                evidenceRefs: ["order-err-1"],
              },
            },
          ],
        },
        tokensUsed: 10,
      });

    const { service, prisma } = buildDeps({
      createChatCompletion,
      aiToolsExecute,
    });

    const result = await service.investigate(baseInput);

    expect(result.status).toBe("FAILED");
    expect(result.error).toMatch(/targetEntityId/);
    expect(prisma.aiDecisionProposal.create).not.toHaveBeenCalled();
  });

  it("a completion that loses the claim race cannot commit a proposal", async () => {
    // Simulate a concurrent finalizer that already terminated the row:
    // the RUNNING->COMPLETED claim matches zero rows, so the transaction
    // must return without persisting a proposal.
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

    const { service, prisma, aiAutonomyService } = buildDeps({
      createChatCompletion,
    });

    (prisma.aiInvestigation.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue(
      { count: 0 },
    );

    const result = await service.investigate(baseInput);

    expect(result.status).toBe("FAILED");
    expect(result.error).toMatch(/timed out before the proposal/i);
    expect(prisma.aiDecisionProposal.create).not.toHaveBeenCalled();
    expect(aiAutonomyService.maybeAutoExecute).not.toHaveBeenCalled();
  });

  // ---- Phase 2B: idempotency, concurrency, cancellation ----

  function uniqueViolation(): Error {
    return new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed on the fields: (`tenantId`,`storeId`,`exceptionId`)",
      { code: "P2002", clientVersion: "6.19.3" },
    );
  }

  it("resumes the existing RUNNING row on a duplicate dispatch (no duplicate record)", async () => {
    const createChatCompletion = vi
      .fn()
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "call-1",
              name: "get_order_detail",
              arguments: { orderId: "order-1" },
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
              arguments: validProposalArgs,
            },
          ],
        },
        tokensUsed: 10,
      });

    const { service, prisma } = buildDeps({ createChatCompletion });

    // The partial unique index rejects the second RUNNING row …
    (prisma.aiInvestigation.create as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(uniqueViolation());
    // … and the existing row's lease is free (expired): the run resumes it.
    (prisma.aiInvestigation.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      { id: "investigation-9" },
    );
    (prisma.aiToolCall.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      { sequence: 7 },
    );

    const result = await service.investigate(baseInput);

    expect(result.status).toBe("COMPLETED");
    expect(result.investigationId).toBe("investigation-9");
    // Exactly one authoritative record: the insert failed once and was NOT
    // retried into a second row.
    expect(prisma.aiInvestigation.create).toHaveBeenCalledTimes(1);
    // Tool-call sequence continues past the resumed run's persisted rows.
    expect(prisma.aiToolCall.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sequence: 8 }),
      }),
    );
  });

  it("attaches to a live run without touching its row or publishing anything", async () => {
    const { service, prisma, aiAutonomyService } = buildDeps({});

    (prisma.aiInvestigation.create as ReturnType<typeof vi.fn>).mockRejectedValue(
      uniqueViolation(),
    );
    (prisma.aiInvestigation.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      { id: "investigation-9" },
    );
    // Lease held by a live executor …
    (prisma.aiInvestigation.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue(
      { count: 0 },
    );
    // … whose outcome the attached dispatch reports read-only.
    (prisma.aiInvestigation.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      { id: "investigation-9", status: "COMPLETED", error: null },
    );
    (prisma.aiDecisionProposal.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      { id: "proposal-77" },
    );

    const result = await service.investigate(baseInput);

    expect(result).toMatchObject({
      investigationId: "investigation-9",
      status: "COMPLETED",
      proposalId: "proposal-77",
      attachedToActiveRun: true,
    });
    expect(prisma.aiDecisionProposal.create).not.toHaveBeenCalled();
    expect(aiAutonomyService.maybeAutoExecute).not.toHaveBeenCalled();
    // The attached dispatch never finalizes anything: the only write it
    // attempted was the (rejected) lease claim.
    const writes = (prisma.aiInvestigation.updateMany as ReturnType<typeof vi.fn>)
      .mock.calls;
    expect(writes).toHaveLength(1);
  });

  it("propagates the abort signal to the provider and fires it on timeout", async () => {
    let capturedSignal: AbortSignal | null = null;

    const createChatCompletion = vi.fn().mockImplementation(
      (input: { signal?: AbortSignal }) =>
        new Promise(() => {
          capturedSignal = input.signal ?? null;
        }),
    );

    const { service } = buildDeps({
      createChatCompletion,
      configValues: { AI_INVESTIGATION_TIMEOUT_MS: 25 },
    });

    const result = await service.investigate(baseInput);

    expect(result.status).toBe("FAILED");
    expect(result.error).toMatch(/timed out/i);
    // The provider request was PHYSICALLY cancelled (fetch-abort signal).
    expect(capturedSignal).not.toBeNull();
    expect((capturedSignal as unknown as AbortSignal).aborted).toBe(true);
  });

  it("takes over a live lease on redelivery (BullMQ stall recovery) but never otherwise", async () => {
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

    const { service, prisma } = buildDeps({ createChatCompletion });

    (prisma.aiInvestigation.create as ReturnType<typeof vi.fn>).mockRejectedValue(
      uniqueViolation(),
    );
    (prisma.aiInvestigation.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      { id: "investigation-9" },
    );
    (prisma.aiInvestigation.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue(
      { count: 1 },
    );

    const result = await service.investigate({
      ...baseInput,
      takeoverClaim: true,
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.investigationId).toBe("investigation-9");

    // The lease-claim update must NOT contain the lease-expiry OR filter —
    // takeover claims unconditionally (single-winner atomicity unchanged).
    const leaseClaim = (
      prisma.aiInvestigation.updateMany as ReturnType<typeof vi.fn>
    ).mock.calls.find((call: unknown[]) => {
      const args = call[0] as { where?: { OR?: unknown } };
      return args.where && args.where.OR === undefined;
    });
    expect(leaseClaim).toBeDefined();
  });

  it("guards the completion claim with the run's execution lease", async () => {
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

    const { service, prisma } = buildDeps({ createChatCompletion });

    const result = await service.investigate(baseInput);

    expect(result.status).toBe("COMPLETED");

    const completionClaim = (
      prisma.aiInvestigation.updateMany as ReturnType<typeof vi.fn>
    ).mock.calls.find((call: unknown[]) => {
      const args = call[0] as { data?: { status?: string } };
      return args.data?.status === "COMPLETED";
    });

    expect(completionClaim).toBeDefined();
    const where = (completionClaim as unknown as [{ where: Record<string, unknown> }])[0]
      .where;
    // A run whose lease was taken over cannot finalize or publish.
    expect(where.executionClaimId).toEqual(expect.any(String));
    expect(where.tenantId).toBe("tenant-1");
    expect(where.exceptionId).toBe("exception-1");
    expect(where.status).toBe("RUNNING");
  });
});

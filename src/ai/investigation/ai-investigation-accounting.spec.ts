import { describe, expect, it, vi } from "vitest";

import { LlmClientError } from "../llm/llm-error";
import { BudgetExceededError } from "../accounting/ai-budget.service";
import {
  AiInvestigationService,
  InvestigateInput,
} from "./ai-investigation.service";
import { SUBMIT_DECISION_PROPOSAL_TOOL } from "./ai-decision-proposal.schema";

const baseInput: InvestigateInput = {
  tenantId: "tenant-1",
  storeId: "store-1",
  exceptionId: "exception-1",
};

const configValues: Record<string, number | string> = {
  AI_INVESTIGATION_MAX_TOOL_CALLS: 5,
  AI_INVESTIGATION_TIMEOUT_MS: 5000,
  AI_INVESTIGATION_MAX_TOKENS: 20000,
  AI_INVESTIGATION_MAX_MODEL_CALLS: 24,
  AI_INVESTIGATION_TOKEN_LIMIT: 100000,
  AI_BUDGET_RESERVATION_TOKENS: 4000,
  AI_TENANT_DAILY_TOKEN_LIMIT: 2000000,
  AI_TENANT_MONTHLY_TOKEN_LIMIT: 40000000,
  GROQ_MODEL: "test-model",
};

/**
 * Phase 2C accounting integration through the real investigation service:
 * budget governance happens BEFORE provider calls, every invocation is
 * accounted (success and failure), unknown usage is conservatively settled,
 * and exhausted budgets persist BUDGET_EXCEEDED as a permanent outcome.
 */
function makeDeps(overrides: {
  createChatCompletion?: ReturnType<typeof vi.fn>;
  usageSummary?: ReturnType<typeof vi.fn>;
  reserve?: ReturnType<typeof vi.fn>;
}) {
  const prisma = {
    aiInvestigation: {
      create: vi.fn().mockResolvedValue({ id: "investigation-1" }),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    aiToolCall: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    },
    aiDecisionProposal: {
      create: vi.fn().mockResolvedValue({ id: "proposal-1" }),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
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
    getToolDefinitions: vi
      .fn()
      .mockReturnValue([{ name: "get_exception_context" }]),
    execute: vi.fn().mockResolvedValue({
      exception: { id: "exception-1" },
      order: { id: "order-1" },
    }),
  };
  const aiAutonomyService = {
    maybeAutoExecute: vi.fn().mockResolvedValue(undefined),
  };

  const config = {
    get: (key: string) => configValues[key],
  };

  const createChatCompletion =
    overrides.createChatCompletion ??
    vi.fn().mockResolvedValue({
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
      usage: {
        inputTokens: 5,
        outputTokens: 5,
        totalTokens: 10,
        source: "ESTIMATED",
      },
    });

  const usageService = {
    recordModelCall: vi.fn().mockResolvedValue({ id: "model-call-1" }),
  };

  const budgetService = {
    usageSummary:
      overrides.usageSummary ??
      vi.fn().mockResolvedValue({ entries: 0, reservedTokens: 0 }),
    limitsFor: vi
      .fn()
      .mockImplementation((_t: string, d: unknown) => Promise.resolve(d)),
    reserve:
      overrides.reserve ??
      vi.fn().mockResolvedValue({ id: "entry-1", reservedTokens: 4000 }),
    settle: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
  };

  const service = new AiInvestigationService(
    prisma as never,
    exceptionService as never,
    auditService as never,
    aiToolsService as never,
    aiAutonomyService as never,
    config as never,
    { provider: "test", createChatCompletion } as never,
    usageService as never,
    budgetService as never,
  );

  return {
    service,
    prisma,
    createChatCompletion,
    usageService,
    budgetService,
    auditService,
  };
}

describe("Investigation accounting integration (Phase 2C)", () => {
  it("BUDGET_EXCEEDED stops provider calls before dispatch and is permanent", async () => {
    const { service, createChatCompletion, usageService, budgetService } =
      makeDeps({
        reserve: vi
          .fn()
          .mockRejectedValue(
            new BudgetExceededError({
              limitKind: "tenant_daily_tokens",
              limit: 10,
              requested: 10,
              reserved: 10,
            }),
          ),
      });

    const result = await service.investigate(baseInput);

    expect(result.status).toBe("FAILED");
    expect(result.failure?.code).toBe("BUDGET_EXCEEDED");
    expect(result.failure?.retryable).toBe(false);
    // The budget gate fired BEFORE dispatch: no provider call happened.
    expect(createChatCompletion).not.toHaveBeenCalled();
    // No model call to account for — nothing was invented.
    expect(usageService.recordModelCall).not.toHaveBeenCalled();
    expect(budgetService.reserve).toHaveBeenCalledTimes(1);
  });

  it("per-investigation model-call cap is enforced before each call", async () => {
    const { service, createChatCompletion } = makeDeps({
      usageSummary: vi
        .fn()
        .mockResolvedValue({ entries: 24, reservedTokens: 96000 }),
    });

    const result = await service.investigate(baseInput);

    expect(result.status).toBe("FAILED");
    expect(result.failure?.code).toBe("BUDGET_EXCEEDED");
    expect(result.failure?.providerDetail?.kind).toBe(
      "investigation_model_calls",
    );
    expect(createChatCompletion).not.toHaveBeenCalled();
  });

  it("accounts every invocation of a multi-call investigation and settles each reservation", async () => {
    const { service, createChatCompletion, usageService, budgetService } =
      makeDeps({
        createChatCompletion: vi
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
            usage: {
              inputTokens: 5,
              outputTokens: 5,
              totalTokens: 10,
              source: "ESTIMATED",
            },
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
            usage: {
              inputTokens: 5,
              outputTokens: 5,
              totalTokens: 10,
              source: "ESTIMATED",
            },
          }),
      });

    const result = await service.investigate(baseInput);

    expect(result.status).toBe("COMPLETED");
    // One accounting row + one reservation settlement PER invocation.
    expect(usageService.recordModelCall).toHaveBeenCalledTimes(2);
    expect(budgetService.reserve).toHaveBeenCalledTimes(2);
    expect(budgetService.settle).toHaveBeenCalledTimes(2);
    expect(createChatCompletion).toHaveBeenCalledTimes(2);
    expect(usageService.recordModelCall).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        provider: "test",
        model: "test-model",
        outcome: "SUCCESS",
        usage: expect.objectContaining({ source: "ESTIMATED" }),
      }),
    );
    // Reservations were settled against the actual usage, not left pending.
    expect(budgetService.settle).toHaveBeenCalledWith(
      expect.objectContaining({ actualTokens: 10, usageSource: "ESTIMATED" }),
    );
  });

  it("timeouts are accounted with unknown usage kept conservatively and classified TIMEOUT", async () => {
    const { service, usageService, budgetService, prisma } = makeDeps({
      createChatCompletion: vi
        .fn()
        .mockRejectedValue(
          new LlmClientError("timeout", "clamped timeout after 15000ms", {
            usageDisposition: "unknown",
          }),
        ),
    });

    const result = await service.investigate(baseInput);

    expect(result.status).toBe("FAILED");
    expect(result.failure?.code).toBe("TIMEOUT");
    // The failed attempt is accounted exactly once.
    expect(usageService.recordModelCall).toHaveBeenCalledTimes(1);
    expect(usageService.recordModelCall).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "TIMEOUT",
        failureCode: "TIMEOUT",
        usage: expect.objectContaining({ source: "UNKNOWN" }),
      }),
    );
    // Unknown usage: the conservative reservation stands and is marked
    // uncertain via settlement — never incorrectly refunded.
    expect(budgetService.settle).toHaveBeenCalledTimes(1);
    expect(budgetService.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        actualTokens: null,
        usageSource: "UNKNOWN",
        usageDisposition: "unknown",
      }),
    );
    expect(budgetService.release).not.toHaveBeenCalled();
    // The terminal row carries the stable code.
    expect(prisma.aiInvestigation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ failureCode: "TIMEOUT" }),
      }),
    );
  });

  it("cancellation is never misreported as a provider failure", async () => {
    const { service, usageService, budgetService } = makeDeps({
      createChatCompletion: vi
        .fn()
        .mockRejectedValue(
          new LlmClientError("cancelled", "run aborted", {
            usageDisposition: "none",
          }),
        ),
    });

    const result = await service.investigate(baseInput);

    expect(result.status).toBe("FAILED");
    expect(result.failure?.code).toBe("CANCELLED");
    expect(usageService.recordModelCall).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "CANCELLED" }),
    );
    // A pre-dispatch cancellation released its reservation — no charge.
    expect(budgetService.release).toHaveBeenCalled();
  });

  it("pre-dispatch failures release the reservation entirely", async () => {
    const { service, budgetService } = makeDeps({
      createChatCompletion: vi
        .fn()
        .mockRejectedValue(
          new LlmClientError(
            "cancelled",
            "Provider call cancelled before dispatch",
            { usageDisposition: "none" },
          ),
        ),
    });

    await service.investigate(baseInput);

    expect(budgetService.release).toHaveBeenCalledTimes(1);
    expect(budgetService.release).toHaveBeenCalledWith(
      expect.any(String),
      "CANCELLED",
    );
    expect(budgetService.settle).not.toHaveBeenCalled();
  });

  it("persists a structured BUDGET_EXCEEDED failure when the tenant budget is exhausted mid-run", async () => {
    const { service, prisma, budgetService } = makeDeps({
      reserve: vi.fn().mockImplementation(() => {
        throw new BudgetExceededError({
          limitKind: "tenant_monthly_tokens",
          limit: 40000,
          requested: 4000,
          reserved: 40000,
        });
      }),
    });

    const result = await service.investigate(baseInput);

    expect(result.status).toBe("FAILED");
    expect(result.failure?.code).toBe("BUDGET_EXCEEDED");
    // The terminal row carries the stable code (not just message text).
    expect(prisma.aiInvestigation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ failureCode: "BUDGET_EXCEEDED" }),
      }),
    );
    expect(budgetService.settle).not.toHaveBeenCalled();
  });

  it("rate limiting maps to the stable RATE_LIMITED classification", async () => {
    const { service, usageService } = makeDeps({
      createChatCompletion: vi
        .fn()
        .mockRejectedValue(
          new LlmClientError("http", "rate limited", {
            status: 429,
            usageDisposition: "none",
          }),
        ),
    });

    const result = await service.investigate(baseInput);

    expect(result.status).toBe("FAILED");
    expect(result.failure?.code).toBe("RATE_LIMITED");
    expect(result.failure?.providerDetail?.httpStatus).toBe(429);
    expect(usageService.recordModelCall).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "RATE_LIMITED" }),
    );
  });

  it("rejects malformed provider output as INVALID_RESPONSE and accounts it", async () => {
    const { service, usageService } = makeDeps({
      createChatCompletion: vi
        .fn()
        .mockRejectedValue(
          new LlmClientError("malformed_response", "empty choices", {
            usageDisposition: "unknown",
          }),
        ),
    });

    const result = await service.investigate(baseInput);

    expect(result.status).toBe("FAILED");
    expect(result.failure?.code).toBe("INVALID_RESPONSE");
    expect(result.failure?.retryable).toBe(false);
    expect(usageService.recordModelCall).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "INVALID_RESPONSE" }),
    );
  });

  it("auth failures map to AUTHENTICATION_FAILED (permanent, classified)", async () => {
    const { service } = makeDeps({
      createChatCompletion: vi
        .fn()
        .mockRejectedValue(
          new LlmClientError("http", "invalid api key", {
            status: 401,
            usageDisposition: "none",
          }),
        ),
    });

    const result = await service.investigate(baseInput);

    expect(result.status).toBe("FAILED");
    expect(result.failure?.code).toBe("AUTHENTICATION_FAILED");
    expect(result.failure?.retryable).toBe(false);
    expect(result.failure?.providerDetail?.httpStatus).toBe(401);
  });
});

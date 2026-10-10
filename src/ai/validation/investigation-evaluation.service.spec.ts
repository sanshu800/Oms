import { describe, expect, it, vi } from "vitest";

import { InvestigationEvaluationService } from "./investigation-evaluation.service";

const baseInput = {
  tenantId: "tenant-1",
  storeId: "store-1",
  exceptionId: "exception-1",
  investigationId: "investigation-1",
  latencyMs: 123,
};

function buildService(rows: {
  investigation: {
    status: "COMPLETED" | "FAILED" | "RUNNING";
    error?: string | null;
    tokensUsed?: number | null;
    toolCallCount?: number;
    toolCalls?: Array<{ toolName: string; input: unknown; output: unknown }>;
  };
  proposals?: Array<{
    actionType: string;
    targetEntityType: string;
    targetEntityId: string;
    evidenceRefs?: unknown;
    reasoningSummary?: string;
  }>;
}) {
  const prisma = {
    aiInvestigation: {
      findFirst: vi.fn().mockResolvedValue({
        id: baseInput.investigationId,
        tenantId: baseInput.tenantId,
        status: rows.investigation.status,
        error: rows.investigation.error ?? null,
        tokensUsed:
          rows.investigation.tokensUsed === undefined
            ? 10
            : rows.investigation.tokensUsed,
        toolCallCount:
          rows.investigation.toolCallCount ??
          (rows.investigation.toolCalls ?? []).length,
        toolCalls: rows.investigation.toolCalls ?? [],
      }),
    },
    aiDecisionProposal: {
      findMany: vi.fn().mockResolvedValue(
        (rows.proposals ?? []).map((proposal, index) => ({
          id: `proposal-${index + 1}`,
          ...proposal,
          reasoningSummary: proposal.reasoningSummary ?? "reasoned from tools",
        })),
      ),
    },
  };

  return new InvestigationEvaluationService(prisma as never);
}

function criterion(
  report: Awaited<
    ReturnType<InstanceType<typeof InvestigationEvaluationService>["evaluate"]>
  >,
  id: string,
) {
  return report.criteria.find((entry) => entry.id === id)!;
}

describe("InvestigationEvaluationService", () => {
  // ---- VALID ----

  it("valid: a grounded, schema-valid proposal passes and records supported metrics", async () => {
    const service = buildService({
      investigation: {
        status: "COMPLETED",
        toolCalls: [
          {
            toolName: "get_exception_context",
            input: { exceptionId: "exception-1" },
            output: { exception: { id: "exception-1" }, order: { id: "order-1" } },
          },
          {
            toolName: "get_inventory_truth",
            input: { sku: "SKU-1" },
            output: { availableQty: 0, reservedQty: 5 },
          },
        ],
      },
      proposals: [
        {
          actionType: "RELEASE_ORDER_RESERVATION",
          targetEntityType: "ORDER",
          targetEntityId: "order-1",
          evidenceRefs: ["exception-1", "order-1"],
        },
      ],
    });

    const report = await service.evaluate(baseInput);

    expect(report.verdict).toBe("PASS");
    expect(criterion(report, "evidence_grounding").status).toBe("PASS");
    expect(criterion(report, "schema_validity").status).toBe("PASS");
    expect(criterion(report, "action_type_supported").status).toBe("PASS");
    expect(criterion(report, "target_entity_correct").status).toBe("PASS");
    expect(report.metrics.latencyMs).toBe(123);
    expect(report.metrics.tokenUsage).toBe(10);
    expect(report.metrics.toolCallCount).toBe(2);
    expect(report.metrics.completionStatus).toBe("COMPLETED");
    expect(report.metrics.evidenceGrounding).toBe("SUPPORTED");
    // Metrics the provider interface cannot supply are marked, not faked.
    expect(report.unavailableMetrics).toContain("schemaValidationFailures");
    expect(report.unavailableMetrics).toContain("providerCallLatencyMs");
    expect(report.metrics.schemaValidationFailures).toBeNull();
  });

  // ---- INVALID ----

  it("invalid: repeated schema-invalid submissions fail schema validity and the verdict", async () => {
    const service = buildService({
      investigation: {
        status: "FAILED",
        error:
          "Model submitted an invalid decision proposal 3 times and did not correct it: targetEntityType",
        toolCalls: [],
      },
      proposals: [],
    });

    const report = await service.evaluate(baseInput);

    expect(report.verdict).toBe("FAIL");
    expect(criterion(report, "schema_validity").status).toBe("FAIL");
    expect(report.metrics.schemaValidationFailureObserved).toBe(true);
    expect(report.metrics.schemaValidationFailures).toBeNull();
    expect(report.metrics.providerFailure).toContain("invalid decision proposal");
  });

  it("invalid: an unknown actionType is flagged as unsupported", async () => {
    const service = buildService({
      investigation: {
        status: "COMPLETED",
        toolCalls: [
          {
            toolName: "get_exception_context",
            input: { exceptionId: "exception-1" },
            output: { id: "exception-1", order: { id: "order-1" } },
          },
        ],
      },
      proposals: [
        {
          actionType: "RELEASE_EVERYTHING",
          targetEntityType: "ORDER",
          targetEntityId: "order-1",
        },
      ],
    });

    const report = await service.evaluate(baseInput);

    expect(report.verdict).toBe("FAIL");
    expect(criterion(report, "action_type_supported").status).toBe("FAIL");
  });

  it("invalid: a mismatched target entity type is flagged (defense in depth)", async () => {
    const service = buildService({
      investigation: {
        status: "COMPLETED",
        toolCalls: [
          {
            toolName: "get_exception_context",
            input: { exceptionId: "exception-1" },
            output: { id: "exception-1" },
          },
        ],
      },
      proposals: [
        {
          actionType: "RELEASE_ORDER_RESERVATION",
          targetEntityType: "OPERATIONAL_EXCEPTION",
          targetEntityId: "exception-1",
        },
      ],
    });

    const report = await service.evaluate(baseInput);

    expect(report.verdict).toBe("FAIL");
    expect(criterion(report, "target_entity_correct").status).toBe("FAIL");
  });

  // ---- AMBIGUOUS (missing evidence) ----

  it("ambiguous: missing evidence yields an explicit uncertainty conclusion and passes", async () => {
    const service = buildService({
      investigation: {
        status: "COMPLETED",
        toolCalls: [
          {
            toolName: "get_exception_context",
            input: { exceptionId: "exception-1" },
            output: { id: "exception-1", order: null },
          },
        ],
      },
      proposals: [
        {
          actionType: "NO_ACTION_INSUFFICIENT_EVIDENCE",
          targetEntityType: "OPERATIONAL_EXCEPTION",
          targetEntityId: "exception-1",
          evidenceRefs: [],
          reasoningSummary:
            "The tool output did not contain enough evidence to act on.",
        },
      ],
    });

    const report = await service.evaluate(baseInput);

    expect(report.verdict).toBe("PASS");
    expect(criterion(report, "uncertainty_on_missing_evidence").status).toBe(
      "PASS",
    );
  });

  it("ambiguous: a concrete conclusion without retrievable evidence fails as invented facts", async () => {
    const service = buildService({
      investigation: {
        status: "COMPLETED",
        toolCalls: [
          {
            toolName: "get_exception_context",
            input: { exceptionId: "exception-1" },
            output: { id: "exception-1", order: { id: "order-1" } },
          },
        ],
      },
      proposals: [
        {
          actionType: "RELEASE_ORDER_RESERVATION",
          targetEntityType: "ORDER",
          targetEntityId: "order-1",
          evidenceRefs: ["exception-1"],
          reasoningSummary: "I am quite sure.",
        },
      ],
    });

    // Grounded… now the same proposal with a fabricated evidence ref:
    const grounded = await service.evaluate(baseInput);
    expect(grounded.verdict).toBe("PASS");

    const adversarial = buildService({
      investigation: {
        status: "COMPLETED",
        toolCalls: [
          {
            toolName: "get_exception_context",
            input: { exceptionId: "exception-1" },
            output: { id: "exception-1", order: { id: "order-1" } },
          },
        ],
      },
      proposals: [
        {
          actionType: "RELEASE_ORDER_RESERVATION",
          targetEntityType: "ORDER",
          targetEntityId: "order-1",
          evidenceRefs: ["order-does-not-exist-9999"],
          reasoningSummary: "I am quite sure.",
        },
      ],
    });

    const report = await adversarial.evaluate(baseInput);

    expect(report.verdict).toBe("FAIL");
    expect(criterion(report, "evidence_grounding").status).toBe("FAIL");
    expect(report.metrics.evidenceGrounding).toBe("UNSUPPORTED");
  });

  // ---- ADVERSARIAL ----

  it("adversarial: a target never observed in tool output is rejected as ungrounded", async () => {
    const service = buildService({
      investigation: {
        status: "COMPLETED",
        toolCalls: [
          {
            toolName: "get_exception_context",
            input: { exceptionId: "exception-1" },
            output: { id: "exception-1", order: { id: "order-1" } },
          },
        ],
      },
      proposals: [
        {
          // Injected instruction tried to redirect the action at another
          // tenant's order that the tools never returned.
          actionType: "RELEASE_ORDER_RESERVATION",
          targetEntityType: "ORDER",
          targetEntityId: "order-from-another-tenant",
          evidenceRefs: ["exception-1"],
          reasoningSummary: "The customer note said to release everything.",
        },
      ],
    });

    const report = await service.evaluate(baseInput);

    expect(report.verdict).toBe("FAIL");
    expect(criterion(report, "evidence_grounding").status).toBe("FAIL");
    expect(criterion(report, "uncertainty_on_missing_evidence").status).toBe(
      "FAIL",
    );
  });

  // ---- FAILURE ----

  it("failure: a provider timeout is recorded and fails completion, with schema validity marked unavailable", async () => {
    const service = buildService({
      investigation: {
        status: "FAILED",
        error: "Investigation timed out",
        toolCallCount: 3,
      },
      proposals: [],
    });

    const report = await service.evaluate(baseInput);

    expect(report.verdict).toBe("FAIL");
    expect(criterion(report, "investigation_completed").status).toBe("FAIL");
    expect(criterion(report, "schema_validity").status).toBe("UNAVAILABLE");
    expect(report.metrics.providerFailure).toContain("timed out");
  });

  it("failure: a transport error text is preserved as the provider failure", async () => {
    const service = buildService({
      investigation: {
        status: "FAILED",
        error: "simulated LLM transport failure",
        toolCallCount: 0,
      },
      proposals: [],
    });

    const report = await service.evaluate(baseInput);

    expect(report.metrics.providerFailure).toContain(
      "simulated LLM transport failure",
    );
    expect(report.metrics.evidenceGrounding).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("failure: termination at an explicit bound counts as bounded", async () => {
    const service = buildService({
      investigation: {
        status: "FAILED",
        error:
          "Investigation ended without a valid submit_decision_proposal call within the tool-call budget",
        toolCallCount: 8,
      },
      proposals: [],
    });

    const report = await service.evaluate(baseInput);

    expect(criterion(report, "bounded_tool_calls").status).toBe("PASS");
  });

  it("marks tokenUsage unavailable when the provider reported none", async () => {
    const service = buildService({
      investigation: {
        status: "COMPLETED",
        tokensUsed: null,
        toolCalls: [
          {
            toolName: "get_exception_context",
            input: { exceptionId: "exception-1" },
            output: { id: "exception-1" },
          },
        ],
      },
      proposals: [
        {
          actionType: "NO_ACTION_INSUFFICIENT_EVIDENCE",
          targetEntityType: "OPERATIONAL_EXCEPTION",
          targetEntityId: "exception-1",
        },
      ],
    });

    const report = await service.evaluate(baseInput);

    expect(report.metrics.tokenUsage).toBeNull();
    expect(report.unavailableMetrics).toContain("tokenUsage");
  });

  it("refuses to evaluate another tenant's investigation", async () => {
    const prisma = {
      aiInvestigation: { findFirst: vi.fn().mockResolvedValue(null) },
      aiDecisionProposal: { findMany: vi.fn() },
    };
    const service = new InvestigationEvaluationService(prisma as never);

    await expect(service.evaluate(baseInput)).rejects.toThrow(
      /not found in this tenant/i,
    );
  });
});

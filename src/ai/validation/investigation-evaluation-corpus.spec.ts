import { readFileSync } from "node:fs";
import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { InvestigationEvaluationService } from "./investigation-evaluation.service";
import type {
  CriterionStatus,
  InvestigationEvaluationReport,
} from "./investigation-evaluation.types";

/**
 * Evaluation corpus regression suite (Task 13 requirement: an expanded,
 * labelled development/holdout evaluation corpus covering normal, ambiguous,
 * conflicting, stale, low-confidence, malformed-output, provider-failure,
 * cross-tenant, and prohibited-action behaviour).
 *
 * Labels live in fixtures/investigation-evaluation/corpus.json with a
 * per-case rationale and a human labelSource note. The holdout split is
 * never used to tune behaviour — the evaluation rules under test are the
 * pre-existing deterministic ones (plus the new low_confidence_flagged
 * criterion, authored before the corpus).
 *
 * Each case is scored through the canonical evaluator
 * (InvestigationEvaluationService.evaluate) with persisted rows mocked to
 * the case's scenario — the same evidence surface the evaluator uses in
 * production (investigation row, AiToolCall trace, proposals).
 */

type CorpusCase = {
  id: string;
  split: "dev" | "holdout";
  category: string;
  rationale: string;
  investigation: {
    status: "COMPLETED" | "FAILED";
    toolCallCount: number;
    tokensUsed: number;
    error: string | null;
  };
  toolCalls: Array<{
    toolName: string;
    input: Record<string, unknown>;
    output: unknown;
    isError: boolean;
  }>;
  proposal: null | {
    actionType: string;
    targetEntityType: string;
    targetEntityId: string;
    params: Record<string, unknown>;
    confidence: number | null;
    basis: string;
    riskTier: string;
    reasoningSummary: string;
    evidenceRefs: string[];
  };
  expected: {
    verdict: "PASS" | "FAIL";
    criteria: Record<string, CriterionStatus>;
  };
};

type Corpus = {
  schemaVersion: number;
  labelSource: string;
  categories: string[];
  cases: CorpusCase[];
};

const corpus: Corpus = JSON.parse(
  readFileSync(
    path.join(
      __dirname,
      "..",
      "..",
      "..",
      "fixtures",
      "investigation-evaluation",
      "corpus.json",
    ),
    "utf8",
  ),
);

/**
 * The exception under investigation for a case: the get_exception_context
 * target when the trace ran one; otherwise the exception an uncertainty
 * conclusion targets; otherwise a neutral placeholder. This mirrors the
 * evaluate() input contract (exceptionId = the exception being investigated).
 */
function deriveExceptionId(corpusCase: CorpusCase): string {
  for (const call of corpusCase.toolCalls) {
    const candidate = (call.input as { exceptionId?: unknown }).exceptionId;
    if (call.toolName === "get_exception_context" && typeof candidate === "string") {
      return candidate;
    }
  }

  const proposal = corpusCase.proposal;
  if (
    proposal &&
    (proposal.actionType === "ESCALATE_TO_HUMAN" ||
      proposal.actionType === "NO_ACTION_INSUFFICIENT_EVIDENCE") &&
    proposal.targetEntityId.startsWith("exception")
  ) {
    return proposal.targetEntityId;
  }

  return "exception-x";
}

function buildServiceForCase(corpusCase: CorpusCase): {
  service: InvestigationEvaluationService;
} {
  const exceptionId = deriveExceptionId(corpusCase);
  const investigationRow = {
    id: `inv-${corpusCase.id}`,
    tenantId: "tenant-A",
    storeId: "store-1",
    exceptionId,
    status: corpusCase.investigation.status,
    toolCallCount: corpusCase.investigation.toolCallCount,
    tokensUsed: corpusCase.investigation.tokensUsed,
    error: corpusCase.investigation.error,
    toolCalls: corpusCase.toolCalls.map((call, index) => ({
      id: `call-${index}`,
      toolName: call.toolName,
      input: call.input,
      output: call.output,
      isError: call.isError,
    })),
  };

  const proposalRows = corpusCase.proposal
    ? [
        {
          id: "proposal-1",
          actionType: corpusCase.proposal.actionType,
          targetEntityType: corpusCase.proposal.targetEntityType,
          targetEntityId: corpusCase.proposal.targetEntityId,
          params: corpusCase.proposal.params,
          confidence: corpusCase.proposal.confidence,
          basis: corpusCase.proposal.basis,
          riskTier: corpusCase.proposal.riskTier,
          reasoningSummary: corpusCase.proposal.reasoningSummary,
          evidenceRefs: corpusCase.proposal.evidenceRefs,
        },
      ]
    : [];

  const prisma = {
    aiInvestigation: {
      findFirst: vi.fn().mockResolvedValue(investigationRow),
    },
    aiDecisionProposal: {
      findMany: vi.fn().mockResolvedValue(proposalRows),
    },
  };

  return {
    service: new InvestigationEvaluationService(prisma as never, undefined),
  };
}

async function evaluateCase(
  corpusCase: CorpusCase,
): Promise<InvestigationEvaluationReport> {
  const { service } = buildServiceForCase(corpusCase);

  return service.evaluate({
    scenario: `corpus:${corpusCase.category}`,
    tenantId: "tenant-A",
    storeId: "store-1",
    exceptionId: deriveExceptionId(corpusCase),
    investigationId: `inv-${corpusCase.id}`,
    latencyMs: null,
  });
}

describe("investigation evaluation corpus", () => {
  it("has explicit label provenance and the required category coverage", () => {
    expect(corpus.schemaVersion).toBe(1);
    expect(corpus.labelSource).toMatch(/human-authored/i);
    expect(corpus.labelSource).toMatch(/no model output/i);

    const requiredCategories = [
      "normal_evidence",
      "ambiguous_evidence",
      "conflicting_facts",
      "stale_state",
      "low_confidence",
      "malformed_outputs",
      "provider_failure",
      "cross_tenant_attempt",
      "prohibited_actions",
    ];

    expect([...corpus.categories].sort()).toEqual([...requiredCategories].sort());

    for (const split of ["dev", "holdout"] as const) {
      const splitCategories = new Set(
        corpus.cases
          .filter((corpusCase) => corpusCase.split === split)
          .map((corpusCase) => corpusCase.category),
      );

      for (const category of requiredCategories) {
        expect(splitCategories, `${split} split must cover ${category}`).toContain(
          category,
        );
      }
    }
  });

  it("keeps dev and holdout ids unique with no duplicate or near-duplicate cases", () => {
    const ids = corpus.cases.map((corpusCase) => corpusCase.id);
    expect(new Set(ids).size).toBe(ids.length);

    // Exact duplicates: identical scenario payloads (investigation outcome,
    // trace, and conclusion together).
    const payloadHashes = corpus.cases.map((corpusCase) =>
      JSON.stringify({
        investigation: corpusCase.investigation,
        toolCalls: corpusCase.toolCalls,
        proposal: corpusCase.proposal,
      }),
    );
    expect(new Set(payloadHashes).size).toBe(payloadHashes.length);

    // Near-duplicates: token-set Jaccard similarity of the natural-language
    // surfaces (rationale + tool outputs + reasoning summary) must stay
    // strictly below 0.9 across ALL pairs — and especially across splits.
    const tokensFor = (corpusCase: CorpusCase): Set<string> => {
      const text = [
        corpusCase.rationale,
        JSON.stringify(corpusCase.toolCalls),
        corpusCase.proposal?.reasoningSummary ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ");
      return new Set(text.split(" ").filter(Boolean));
    };

    const jaccard = (a: Set<string>, b: Set<string>): number => {
      const intersection = [...a].filter((token) => b.has(token)).length;
      const union = new Set([...a, ...b]).size;
      return union === 0 ? 0 : intersection / union;
    };

    for (let i = 0; i < corpus.cases.length; i += 1) {
      for (let j = i + 1; j < corpus.cases.length; j += 1) {
        const left = corpus.cases[i];
        const right = corpus.cases[j];

        if (!left || !right) {
          continue;
        }

        const similarity = jaccard(tokensFor(left), tokensFor(right));
        expect(
          similarity,
          `cases ${left.id} / ${right.id} are near-duplicates (${similarity.toFixed(2)})`,
        ).toBeLessThan(0.9);
      }
    }
  });

  for (const corpusCase of corpus.cases) {
    it(`${corpusCase.split}/${corpusCase.id}: ${corpusCase.category}`, async () => {
      expect(corpusCase.rationale.length).toBeGreaterThan(20);

      const report = await evaluateCase(corpusCase);

      expect(report.verdict).toBe(corpusCase.expected.verdict);

      for (const [criterionId, expectedStatus] of Object.entries(
        corpusCase.expected.criteria,
      )) {
        const result = report.criteria.find(
          (criterion) => criterion.id === criterionId,
        );

        expect(result, `criterion ${criterionId} must exist`).toBeDefined();
        expect(
          result?.status,
          `criterion ${criterionId} for ${corpusCase.id} (rationale: ${corpusCase.rationale})`,
        ).toBe(expectedStatus);
      }
    });
  }
});

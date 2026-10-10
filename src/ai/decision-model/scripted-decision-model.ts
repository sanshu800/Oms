/**
 * Deterministic DecisionModel double for tests and the comparison runner's
 * regression mode. Answers are scripted explicitly per use case and
 * validated through the same schemas the Jev client uses — including
 * deliberately invalid or failure scripts (no invented fallbacks here
 * either: an unscripted call is an explicit error outcome).
 */

import { DecisionModel } from "./decision-model.interface";
import {
  DecisionAnswer,
  DecisionOutcome,
  DecisionRequest,
  DecisionUseCase,
  LOW_CONFIDENCE_THRESHOLD,
  jevChoiceAnswerSchema,
  jevScoreAnswerSchema,
} from "./decision-model.types";

export type ScriptedDecision =
  | { kind: "answer"; answer: DecisionAnswer; model?: string; usage?: { inputTokens: number; outputTokens: number } | null }
  | { kind: "failure"; status: "TIMEOUT" | "VALIDATION_FAILED" | "PROVIDER_ERROR" | "UNAVAILABLE"; error?: string };

export class ScriptedDecisionModel implements DecisionModel {
  private readonly scripts = new Map<DecisionUseCase, ScriptedDecision[]>();
  readonly calls: DecisionRequest[] = [];

  /** Queue one scripted result for a use case (consumed FIFO). */
  script(useCase: DecisionUseCase, decision: ScriptedDecision): this {
    const queue = this.scripts.get(useCase) ?? [];
    queue.push(decision);
    this.scripts.set(useCase, queue);
    return this;
  }

  async decide(request: DecisionRequest): Promise<DecisionOutcome> {
    this.calls.push(request);
    const startedAt = Date.now();

    const queue = this.scripts.get(request.useCase);
    const next = queue?.shift();

    if (!next) {
      return {
        status: "UNAVAILABLE",
        useCase: request.useCase,
        error:
          "ScriptedDecisionModel has no scripted answer for this call — no fallback is invented",
        latencyMs: Date.now() - startedAt,
      };
    }

    if (next.kind === "failure") {
      return {
        status: next.status,
        useCase: request.useCase,
        error: next.error ?? `scripted ${next.status}`,
        latencyMs: Date.now() - startedAt,
      };
    }

    // Validate scripted answers through the SAME wire schemas the Jev
    // client enforces, so a bad fixture fails the same way in tests.
    const asWire =
      next.answer.kind === "choice"
        ? jevChoiceAnswerSchema.safeParse({
            type: "choice",
            choice: next.answer.choice,
            confidence: next.answer.confidence,
            probabilities: next.answer.probabilities,
          })
        : jevScoreAnswerSchema.safeParse({
            type: "score",
            score: next.answer.score,
            confidence: next.answer.confidence,
            legend: next.answer.legend,
            probabilities: next.answer.probabilities,
          });

    if (!asWire.success) {
      return {
        status: "VALIDATION_FAILED",
        useCase: request.useCase,
        error: `scripted answer failed schema validation: ${asWire.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
        latencyMs: Date.now() - startedAt,
      };
    }

    return {
      status: "OK",
      useCase: request.useCase,
      answer: next.answer,
      lowConfidence:
        next.answer.confidence < LOW_CONFIDENCE_THRESHOLD,
      model: next.model ?? "scripted-double",
      latencyMs: Date.now() - startedAt,
      usage: next.usage ?? { inputTokens: 0, outputTokens: 0 },
    };
  }
}

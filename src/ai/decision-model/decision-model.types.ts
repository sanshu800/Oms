/**
 * Jev DecisionModel — domain + wire contracts.
 *
 * VERIFIED PROVIDER CONTRACT (TypeSafe AI OpenAPI 3.1.0,
 * https://api.typesafe.ai/openapi.json, retrieved 2026-10-10):
 *
 *   POST /v1/systemone   (HTTPBearer)
 *     SystemOneRequest  = { state: string|object|array, model: string,
 *                           questions: map<string, Question> (min 1) }
 *     Question          = NoulQuestion | ChoiceQuestion | ScoreQuestion
 *                         (discriminator `type`)
 *       ChoiceQuestion  = { type:"choice", instructions?, criteria: map<option, …> }
 *       ScoreQuestion   = { type:"score",  instructions?, criteria: array (levels from 0) }
 *       NoulQuestion    = { type:"noul",   instructions?, criteria?: { true?, false? } }
 *     SystemOneResponse = { model: string, answers: map<string, Answer>, usage }
 *     Answer            = ChoiceAnswer | ScoreAnswer | NoulAnswer (discriminator `type`)
 *       ChoiceAnswer    = { type:"choice", choice, confidence, probabilities }
 *       ScoreAnswer     = { type:"score", score, confidence, legend, probabilities }
 *       NoulAnswer      = { type:"noul", noul }            ← NO confidence field
 *     Usage             = { input_tokens: int, output_tokens: int } (both required)
 *     422 → HTTPValidationError { detail: [{ loc, msg, type }] }
 *   GET /v1/models
 *     ModelMetadataList = { models: [{ name, description, release_date }] }
 *   Docs additionally specify: 401 (bad key), 429 (rate limit, retry-after),
 *   529 (overloaded). The OpenAPI document only schema-checks 200 and 422.
 *
 * Advisory-only capability (V1): every outcome is a signal. Nothing in this
 * package authorizes, approves, or executes anything — proposal
 * authorization, actuation, and autonomy policy are out of scope and
 * untouched.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Use cases and closed decision sets (code-owned; the model can only pick
// from these — it cannot invent an option outside them, and we re-validate).
// ---------------------------------------------------------------------------

export const DECISION_USE_CASES = [
  "EXCEPTION_CLASSIFICATION",
  "URGENCY_SCORING",
  "INVESTIGATION_PATH_ROUTING",
] as const;

export type DecisionUseCase = (typeof DECISION_USE_CASES)[number];

/**
 * Classification options are aligned 1:1 with the deterministic detector's
 * OrderFailureDetectionStatus so baseline comparison is apples-to-apples.
 */
export const CLASSIFICATION_OPTIONS = [
  "FULFILLABLE",
  "INSUFFICIENT_INVENTORY",
  "ZERO_AVAILABILITY",
  "UNKNOWN_SKU",
  "STALE_INVENTORY",
] as const;

export type ClassificationOption = (typeof CLASSIFICATION_OPTIONS)[number];

/** Urgency rubric levels (Score; index = score value). */
export const URGENCY_LEVELS = [
  "Can wait: no customer-visible impact yet; fully reversible",
  "Needs attention this week: one order affected, recoverable delay",
  "Needs attention today: customer-visible delay likely for this order",
  "Critical now: money, multiple orders, or hard-to-reverse impact",
] as const;

export type UrgencyBand = 0 | 1 | 2 | 3;

/**
 * Routing plans are WHOLE, predefined tool-evidence paths. The model never
 * names tools directly, so a nonexistent tool can never be selected.
 */
export const ROUTING_PLANS = [
  "INVENTORY_FIRST",
  "ORDER_HISTORY_FIRST",
  "TENANT_MEMORY_FIRST",
  "ESCALATE_IMMEDIATELY",
] as const;

export type RoutingPlan = (typeof ROUTING_PLANS)[number];

// ---------------------------------------------------------------------------
// Internal evidence. Identifiers may be present here (callers hold them);
// decision-redaction.ts strips them before anything leaves the process.
// ---------------------------------------------------------------------------

export type TriageEvidence = {
  /** Identifier fields — NEVER transmitted to any provider. */
  tenantId?: string;
  storeId?: string;
  orderId?: string;
  orderNumber?: string;
  sku?: string;

  /** Operational facts (transmitted per the documented allowlist). */
  detectionStatus: ClassificationOption;
  skuKnown: boolean;
  requestedQty: number;
  availableQty: number | null;
  shortageQty: number;
  inventoryIsStale: boolean;
  orderAgeHours: number;
  /** Untrusted external text (may contain injection attempts — data only). */
  lineItemTitle: string | null;
  customerNote: string | null;
  /** Count only; never ids of past exceptions. */
  priorExceptionsForSku: number;
};

/** The redacted state actually sent to the provider (see decision-redaction). */
export type DecisionState = Record<string, string | number | boolean | null>;

// ---------------------------------------------------------------------------
// Port outcomes. The port NEVER throws and NEVER invents a fallback decision:
// if Jev is unavailable or wrong-shaped, the outcome is an explicit failure.
// ---------------------------------------------------------------------------

export type ChoiceDecisionAnswer = {
  kind: "choice";
  choice: ClassificationOption | RoutingPlan;
  probabilities: Record<string, number>;
  confidence: number;
};

export type ScoreDecisionAnswer = {
  kind: "score";
  score: number;
  probabilities: Record<string, number>;
  legend: Record<string, string>;
  confidence: number;
};

export type DecisionAnswer = ChoiceDecisionAnswer | ScoreDecisionAnswer;

export type DecisionUsage = {
  inputTokens: number;
  outputTokens: number;
};

export type DecisionFailureStatus =
  | "TIMEOUT"
  | "VALIDATION_FAILED"
  | "PROVIDER_ERROR"
  | "UNAVAILABLE";

export type DecisionOutcome =
  | {
      status: "OK";
      useCase: DecisionUseCase;
      answer: DecisionAnswer;
      lowConfidence: boolean;
      /** Versioned model id reported by the provider (e.g. "jev-1.13.0"). */
      model: string;
      latencyMs: number;
      usage: DecisionUsage | null;
    }
  | {
      status: DecisionFailureStatus;
      useCase: DecisionUseCase;
      error: string;
      latencyMs: number;
    };

/** Flag-only threshold; calibrated later against labelled holdout data. */
export const LOW_CONFIDENCE_THRESHOLD = 0.5;

export type DecisionRequest = {
  useCase: DecisionUseCase;
  evidence: TriageEvidence;
  /** Clamped to [MIN, MAX] by the client. */
  timeoutMs?: number;
};

// ---------------------------------------------------------------------------
// Wire schemas — mirrored from the OpenAPI document and validated on every
// response. An answer that fails these is VALIDATION_FAILED, never coerced.
// ---------------------------------------------------------------------------

export const jevChoiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  confidence: z.number().min(0).max(1),
  probabilities: z.record(z.string(), z.number().min(0).max(1)),
});

export const jevScoreAnswerSchema = z.object({
  type: z.literal("score"),
  score: z.number(),
  confidence: z.number().min(0).max(1),
  legend: z.record(z.string(), z.string()),
  probabilities: z.record(z.string(), z.number().min(0).max(1)),
});

export const jevNoulAnswerSchema = z.object({
  type: z.literal("noul"),
  noul: z.number().min(0).max(1),
});

export const jevAnswerSchema = z.discriminatedUnion("type", [
  jevChoiceAnswerSchema,
  jevScoreAnswerSchema,
  jevNoulAnswerSchema,
]);

export const jevSystemOneResponseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), jevAnswerSchema),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
});

export const jevModelMetadataSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  release_date: z.string(),
});

export const jevModelMetadataListSchema = z.object({
  models: z.array(jevModelMetadataSchema),
});

export type JevSystemOneResponse = z.infer<typeof jevSystemOneResponseSchema>;
export type JevModelMetadataList = z.infer<typeof jevModelMetadataListSchema>;

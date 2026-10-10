/**
 * Provider-agnostic evaluation contract for AI investigations.
 *
 * Everything here describes the outcome of ONE investigation run over
 * rows that already exist in the database (AiInvestigation, AiToolCall,
 * AiDecisionProposal). The evaluation logic never talks to a model; a
 * deterministic test double and a real LLM provider are interchangeable
 * behind the existing LLM_CLIENT port precisely because scoring happens
 * here, afterwards, over persisted evidence.
 *
 * Metric honesty rule: when the current provider interface or persistence
 * layer cannot support a metric, it is reported as `null` with an explicit
 * entry in `unavailableMetrics`. Values are never invented.
 */

export type CriterionStatus = "PASS" | "FAIL" | "UNAVAILABLE";

export type CriterionId =
  | "investigation_completed"
  | "schema_validity"
  | "action_type_supported"
  | "target_entity_correct"
  | "evidence_grounding"
  | "uncertainty_on_missing_evidence"
  | "bounded_tool_calls"
  | "low_confidence_flagged"
  | "untrusted_external_text"
  | "tenant_boundary";

export type CriterionResult = {
  id: CriterionId;
  status: CriterionStatus;
  detail: string;
};

export type EvidenceGroundingOutcome =
  | "SUPPORTED"
  | "UNSUPPORTED"
  | "INSUFFICIENT_EVIDENCE"
  | "UNAVAILABLE";

export type InvestigationMetrics = {
  /**
   * Wall-clock milliseconds measured by the harness around the
   * investigate() call. Supported (harness-measured).
   */
  latencyMs: number | null;
  /**
   * Tokens reported by the provider via LlmChatCompletionResult.
   * `null` when the provider reported `null` — not invented.
   */
  tokenUsage: number | null;
  /** Persisted AiToolCall count. Supported. */
  toolCallCount: number;
  /** Persisted investigation status. Supported. */
  completionStatus: "COMPLETED" | "FAILED" | "RUNNING";
  /**
   * Exact count of schema-invalid proposal submissions.
   * `null` — the orchestrator does not persist invalid attempts; only
   * the derived boolean below is knowable from the investigation error.
   */
  schemaValidationFailures: number | null;
  /** Derived from the investigation error text. Supported (derived). */
  schemaValidationFailureObserved: boolean;
  evidenceGrounding: EvidenceGroundingOutcome;
  /** Investigation error text for provider/timeout/schema exhaustion. */
  providerFailure: string | null;
  /**
   * `null` — per-call provider latency is NOT reported by the current
   * LlmClient interface. Marked unavailable, not estimated.
   */
  providerCallLatencyMs: number | null;
};

export type InvestigationEvaluationReport = {
  scenario: string | null;
  tenantId: string;
  storeId: string;
  exceptionId: string;
  investigationId: string;
  proposalIds: string[];
  verdict: "PASS" | "FAIL";
  criteria: CriterionResult[];
  metrics: InvestigationMetrics;
  /** Metric names that are explicitly unavailable in this run. */
  unavailableMetrics: string[];
};

export const KNOWN_ACTION_TYPES = [
  "RELEASE_ORDER_RESERVATION",
  "ADD_ORDER_NOTE",
  "ESCALATE_TO_HUMAN",
  "NO_ACTION_INSUFFICIENT_EVIDENCE",
] as const;

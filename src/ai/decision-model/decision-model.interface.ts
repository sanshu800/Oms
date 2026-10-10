import {
  DecisionOutcome,
  DecisionRequest,
} from "./decision-model.types";

/**
 * Provider-agnostic bounded-decision contract.
 *
 * Separate from LLM_CLIENT by design: a DecisionModel answers closed,
 * typed questions (classification, scoring, routing choices); the
 * generative LLM client handles investigation, explanation, and proposal
 * generation. Jev (TypeSafe AI) is one implementation behind this port.
 *
 * Safety contract of this interface:
 *  - decide() NEVER throws — failures are explicit typed statuses.
 *  - decide() NEVER invents a fallback decision when a provider is
 *    unavailable; there is no default answer to fall back to.
 *  - Outcomes are ADVISORY signals only. Nothing in this package, and no
 *    consumer of this port, may authorize, approve, or execute mutations.
 *    Application-level authorization (AiDecisionService, human-only
 *    RELEASE, autonomy policy) remains the sole source of truth.
 */
export const DECISION_MODEL = Symbol("DECISION_MODEL");

export type DecisionModel = {
  decide(request: DecisionRequest): Promise<DecisionOutcome>;
};

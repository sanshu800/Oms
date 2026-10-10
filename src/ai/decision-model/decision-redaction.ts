/**
 * Data minimization boundary for the Jev DecisionModel.
 *
 * Rule (V1): tenant identifiers, store identifiers, order identifiers,
 * order numbers, SKUs, customer identity, and absolute timestamps are
 * INTERNAL and are never transmitted to the external provider. Only the
 * fields listed in TRANSMITTED_STATE_FIELDS leave the process, and
 * free-text excerpts are truncated and pattern-redacted on the way out.
 *
 * The exact transmitted fields are frozen below and asserted by
 * decision-redaction.spec.ts — change the list only deliberately.
 */

import {
  ClassificationOption,
  DecisionState,
  DecisionUseCase,
  TriageEvidence,
} from "./decision-model.types";

/** Max characters of untrusted external text sent per field. */
export const EXCERPT_MAX_CHARS = 240;

const COMMON_FIELDS = [
  "detectionStatus",
  "skuKnown",
  "requestedQty",
  "availableQty",
  "shortageQty",
  "inventoryIsStale",
  "orderAgeHours",
  "priorExceptionsForSku",
] as const;

/**
 * EXACT allowlist of state fields transmitted to the provider per use case.
 * Anything not listed here is stripped. Frozen on purpose.
 */
export const TRANSMITTED_STATE_FIELDS: Record<
  DecisionUseCase,
  readonly string[]
> = {
  EXCEPTION_CLASSIFICATION: COMMON_FIELDS,
  URGENCY_SCORING: [
    ...COMMON_FIELDS,
    "lineItemTitleExcerpt",
    "customerNoteExcerpt",
  ],
  INVESTIGATION_PATH_ROUTING: COMMON_FIELDS,
};

/** Fields that must never appear in any transmitted state (defence in depth). */
export const FORBIDDEN_STATE_SUBSTRINGS = [
  "tenantId",
  "tenant",
  "storeId",
  "orderId",
  "orderNumber",
  "externalOrderId",
  "sku",
  "email",
  "phone",
  "address",
  "customerName",
] as const;

const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/** Truncate + strip identity-shaped tokens from untrusted external text. */
export function redactExcerpt(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }

  const flattened = raw.replace(/\s+/g, " ").trim();
  const redacted = flattened
    .replace(UUID_PATTERN, "[redacted-id]")
    .replace(EMAIL_PATTERN, "[redacted-email]");

  if (redacted.length <= EXCERPT_MAX_CHARS) {
    return redacted;
  }

  return `${redacted.slice(0, EXCERPT_MAX_CHARS)}…`;
}

/**
 * Build the external state for a decision call: strictly the use case's
 * allowlisted fields, copied from internal evidence. Identifiers on the
 * evidence object are never read into the state.
 */
export function buildDecisionState(
  useCase: DecisionUseCase,
  evidence: TriageEvidence,
): DecisionState {
  const allowed = TRANSMITTED_STATE_FIELDS[useCase];
  const state: DecisionState = {};

  for (const field of allowed) {
    switch (field) {
      case "detectionStatus":
        state.detectionStatus = evidence.detectionStatus as ClassificationOption;
        break;
      case "skuKnown":
        state.skuKnown = evidence.skuKnown;
        break;
      case "requestedQty":
        state.requestedQty = evidence.requestedQty;
        break;
      case "availableQty":
        state.availableQty = evidence.availableQty;
        break;
      case "shortageQty":
        state.shortageQty = evidence.shortageQty;
        break;
      case "inventoryIsStale":
        state.inventoryIsStale = evidence.inventoryIsStale;
        break;
      case "orderAgeHours":
        state.orderAgeHours = evidence.orderAgeHours;
        break;
      case "priorExceptionsForSku":
        state.priorExceptionsForSku = evidence.priorExceptionsForSku;
        break;
      case "lineItemTitleExcerpt":
        state.lineItemTitleExcerpt = redactExcerpt(evidence.lineItemTitle);
        break;
      case "customerNoteExcerpt":
        state.customerNoteExcerpt = redactExcerpt(evidence.customerNote);
        break;
      default:
        throw new Error(
          `TRANSMITTED_STATE_FIELDS lists unknown field "${field}" — update buildDecisionState`,
        );
    }
  }

  return state;
}

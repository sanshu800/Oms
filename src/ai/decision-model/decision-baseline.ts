/**
 * The EXISTING deterministic baseline — what today's production logic
 * decides on the same evidence. Used by the comparison runner so a
 * candidate DecisionModel can be scored against current behavior AND
 * against human labels. Not a model; plain code.
 *
 * Sources of truth encoded here:
 *  - classification: OrderFailureDetectorService's status logic
 *    (priority: UNKNOWN_SKU > STALE_INVENTORY > ZERO_AVAILABILITY >
 *    INSUFFICIENT_INVENTORY > FULFILLABLE).
 *  - urgency: OrderFailureExceptionService currently assigns
 *    ExceptionSeverity.HIGH to every detected order failure
 *    (order-failure-exception.service.ts:46) — flat, no differentiation.
 *    Baseline urgency band is therefore 3 (critical) whenever a failure is
 *    detected and 0 for FULFILLABLE.
 *  - routing: no automated router exists today. The heuristic below
 *    represents the current de-facto gather order (exception context and
 *    inventory truth first) and is documented as such — it is NOT claimed
 *    as an official policy.
 */

import {
  ClassificationOption,
  RoutingPlan,
  TriageEvidence,
  UrgencyBand,
} from "./decision-model.types";

export function baselineClassification(
  evidence: TriageEvidence,
): ClassificationOption {
  if (!evidence.skuKnown) {
    return "UNKNOWN_SKU";
  }

  if (evidence.inventoryIsStale) {
    return "STALE_INVENTORY";
  }

  if (evidence.availableQty === 0) {
    return "ZERO_AVAILABILITY";
  }

  if (
    evidence.availableQty !== null &&
    evidence.requestedQty > evidence.availableQty
  ) {
    return "INSUFFICIENT_INVENTORY";
  }

  return "FULFILLABLE";
}

export function baselineUrgencyBand(
  evidence: TriageEvidence,
): UrgencyBand {
  const classification = baselineClassification(evidence);

  if (classification === "FULFILLABLE") {
    return 0;
  }

  // Flat HIGH today (order-failure-exception.service.ts:46).
  return 3;
}

export function baselineRoutingPlan(
  evidence: TriageEvidence,
): RoutingPlan {
  const classification = baselineClassification(evidence);

  switch (classification) {
    case "INSUFFICIENT_INVENTORY":
    case "ZERO_AVAILABILITY":
    case "STALE_INVENTORY":
      return "INVENTORY_FIRST";
    case "UNKNOWN_SKU":
      return "ORDER_HISTORY_FIRST";
    case "FULFILLABLE":
      return "ESCALATE_IMMEDIATELY";
  }
}

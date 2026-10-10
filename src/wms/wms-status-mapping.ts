/**
 * Explicit mapping: canonical WMS warehouse events → TechMart
 * fulfillment/shipment state.
 *
 * Locked properties of this table (Stage 1):
 *
 * 1. **Warehouse execution is not shipping.** Pick/pack events record
 *    execution progress only; they never touch Shipment state and never
 *    imply a label, an AWB, or carrier handover. Conversely, shipping-
 *    provider facts (label created, AWB assigned, tracking number) are
 *    NOT warehouse events and are not part of the WMS vocabulary at all —
 *    a label cannot arrive here and pretend an item was picked, packed,
 *    or handed to a carrier. Those facts belong to shipping-provider
 *    integrations (Stage 2+, e.g. Shiprocket) and drive Shipment status
 *    only.
 * 2. **Unknown events are rejected, not guessed.** An eventType outside
 *    WMS_EVENT_TYPES resolves to no effect and the delivery is recorded
 *    with a rejection reason; domain state is untouched.
 * 3. **Illegal transitions are rejected, not coerced.** An event that does
 *    not fit the fulfillment's current canonical state (e.g. a handover
 *    before the request was ever acknowledged) is recorded as rejected;
 *    domain state is untouched.
 */

import { FulfillmentStatus } from "@prisma/client";

import { WMS_EVENT_TYPES } from "./wms-contract";

/** The canonical domain effect of one warehouse event. */
export type WmsEffect =
  | { kind: "START_FULFILLMENT" }
  | { kind: "RECORD_PICK_PROGRESS" }
  | { kind: "RECORD_PACK_PROGRESS" }
  | { kind: "SHIP_QUANTITIES" }
  | { kind: "FAIL_FULFILLMENT" }
  | { kind: "CANCEL_FULFILLMENT" };

const EFFECT_BY_EVENT_TYPE: Record<string, WmsEffect> = {
  [WMS_EVENT_TYPES.ACKNOWLEDGED]: { kind: "START_FULFILLMENT" },
  [WMS_EVENT_TYPES.PICKED]: { kind: "RECORD_PICK_PROGRESS" },
  [WMS_EVENT_TYPES.PACKED]: { kind: "RECORD_PACK_PROGRESS" },
  [WMS_EVENT_TYPES.SHIPPED]: { kind: "SHIP_QUANTITIES" },
  [WMS_EVENT_TYPES.FAILED]: { kind: "FAIL_FULFILLMENT" },
  [WMS_EVENT_TYPES.CANCELLED]: { kind: "CANCEL_FULFILLMENT" },
};

/**
 * External warehouse event type → canonical effect. Null = unknown:
 * reject and record; never mutate state.
 */
export function resolveWmsEffect(eventType: string): WmsEffect | null {
  return EFFECT_BY_EVENT_TYPE[eventType] ?? null;
}

/**
 * Explicit transition legality: which canonical fulfillment statuses each
 * effect may legally apply to. Idempotent repeats (same effect while
 * already in the resulting state) are legal no-ops — the domain methods
 * early-return — but a REGRESSION (e.g. an old pick event after the
 * fulfillment already failed) is illegal and must be rejected.
 */
const LEGAL_FULFILLMENT_STATUSES: Record<WmsEffect["kind"], readonly FulfillmentStatus[]> = {
  // READY → IN_PROGRESS; a repeated ack while already IN_PROGRESS is a
  // duplicate of the same semantic step (idempotent no-op).
  START_FULFILLMENT: [
    FulfillmentStatus.READY,
    FulfillmentStatus.IN_PROGRESS,
  ],

  // Execution progress only while the fulfillment is being worked.
  RECORD_PICK_PROGRESS: [
    FulfillmentStatus.IN_PROGRESS,
    FulfillmentStatus.PARTIALLY_FULFILLED,
  ],
  RECORD_PACK_PROGRESS: [
    FulfillmentStatus.IN_PROGRESS,
    FulfillmentStatus.PARTIALLY_FULFILLED,
  ],

  // Handover to carrier — only from an active execution.
  SHIP_QUANTITIES: [
    FulfillmentStatus.IN_PROGRESS,
    FulfillmentStatus.PARTIALLY_FULFILLED,
  ],

  // Failure/cancellation only before anything shipped (mirrors the
  // domain's cancel guard; partially-shipped stock is committed stock
  // and must not be released by a late failure).
  FAIL_FULFILLMENT: [FulfillmentStatus.READY, FulfillmentStatus.IN_PROGRESS],
  CANCEL_FULFILLMENT: [
    FulfillmentStatus.READY,
    FulfillmentStatus.IN_PROGRESS,
  ],
};

export function isLegalWmsTransition(
  effect: WmsEffect,
  fulfillmentStatus: FulfillmentStatus,
): boolean {
  return LEGAL_FULFILLMENT_STATUSES[effect.kind].includes(fulfillmentStatus);
}

/** Human-readable reason strings for recorded rejections (never silent). */
export function describeIllegalTransition(
  effect: WmsEffect,
  fulfillmentStatus: FulfillmentStatus,
): string {
  const allowed = LEGAL_FULFILLMENT_STATUSES[effect.kind]
    .map((status) => status.toString())
    .join(", ");

  return `Illegal warehouse transition ${effect.kind} from fulfillment status ${fulfillmentStatus} (allowed: ${allowed})`;
}

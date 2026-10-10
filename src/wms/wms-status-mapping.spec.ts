import { describe, expect, it } from "vitest";
import { FulfillmentStatus } from "@prisma/client";

import { WMS_EVENT_TYPES } from "./wms-contract";
import {
  describeIllegalTransition,
  isLegalWmsTransition,
  resolveWmsEffect,
} from "./wms-status-mapping";

describe("WMS status mapping", () => {
  it("maps every canonical warehouse event to its documented effect", () => {
    expect(resolveWmsEffect(WMS_EVENT_TYPES.ACKNOWLEDGED)).toEqual({
      kind: "START_FULFILLMENT",
    });
    expect(resolveWmsEffect(WMS_EVENT_TYPES.PICKED)).toEqual({
      kind: "RECORD_PICK_PROGRESS",
    });
    expect(resolveWmsEffect(WMS_EVENT_TYPES.PACKED)).toEqual({
      kind: "RECORD_PACK_PROGRESS",
    });
    expect(resolveWmsEffect(WMS_EVENT_TYPES.SHIPPED)).toEqual({
      kind: "SHIP_QUANTITIES",
    });
    expect(resolveWmsEffect(WMS_EVENT_TYPES.FAILED)).toEqual({
      kind: "FAIL_FULFILLMENT",
    });
    expect(resolveWmsEffect(WMS_EVENT_TYPES.CANCELLED)).toEqual({
      kind: "CANCEL_FULFILLMENT",
    });
  });

  it("resolves unknown warehouse statuses to nothing (reject, never guess)", () => {
    // Shipping-provider vocabulary is deliberately NOT a warehouse event:
    // a label/AWB must never imply pick/pack/handover.
    for (const unknown of [
      "fulfillment.label_created",
      "shipment.awb_assigned",
      "fulfillment.picking",
      "FULFILLMENT_SHIPPED",
      "",
    ]) {
      expect(resolveWmsEffect(unknown)).toBeNull();
    }
  });

  it("allows execution effects only from active fulfillment states", () => {
    const active = [
      FulfillmentStatus.IN_PROGRESS,
      FulfillmentStatus.PARTIALLY_FULFILLED,
    ];

    for (const status of active) {
      expect(isLegalWmsTransition({ kind: "RECORD_PICK_PROGRESS" }, status)).toBe(true);
      expect(isLegalWmsTransition({ kind: "RECORD_PACK_PROGRESS" }, status)).toBe(true);
      expect(isLegalWmsTransition({ kind: "SHIP_QUANTITIES" }, status)).toBe(true);
    }

    for (const status of [
      FulfillmentStatus.READY,
      FulfillmentStatus.FULFILLED,
      FulfillmentStatus.FAILED,
      FulfillmentStatus.CANCELLED,
    ]) {
      expect(isLegalWmsTransition({ kind: "SHIP_QUANTITIES" }, status)).toBe(false);
    }
  });

  it("never allows a handover before the request was acknowledged", () => {
    expect(
      isLegalWmsTransition(
        { kind: "SHIP_QUANTITIES" },
        FulfillmentStatus.READY,
      ),
    ).toBe(false);
  });

  it("allows start from READY (idempotent repeat from IN_PROGRESS)", () => {
    expect(
      isLegalWmsTransition({ kind: "START_FULFILLMENT" }, FulfillmentStatus.READY),
    ).toBe(true);
    expect(
      isLegalWmsTransition(
        { kind: "START_FULFILLMENT" },
        FulfillmentStatus.IN_PROGRESS,
      ),
    ).toBe(true);
    expect(
      isLegalWmsTransition(
        { kind: "START_FULFILLMENT" },
        FulfillmentStatus.FULFILLED,
      ),
    ).toBe(false);
  });

  it("allows failure/cancellation only before anything shipped", () => {
    for (const effect of [
      { kind: "FAIL_FULFILLMENT" },
      { kind: "CANCEL_FULFILLMENT" },
    ] as const) {
      expect(isLegalWmsTransition(effect, FulfillmentStatus.READY)).toBe(true);
      expect(
        isLegalWmsTransition(effect, FulfillmentStatus.IN_PROGRESS),
      ).toBe(true);
      expect(
        isLegalWmsTransition(effect, FulfillmentStatus.PARTIALLY_FULFILLED),
      ).toBe(false);
      expect(
        isLegalWmsTransition(effect, FulfillmentStatus.FULFILLED),
      ).toBe(false);
    }
  });

  it("describes illegal transitions with the allowed set (recorded, never silent)", () => {
    const reason = describeIllegalTransition(
      { kind: "SHIP_QUANTITIES" },
      FulfillmentStatus.READY,
    );

    expect(reason).toContain("SHIP_QUANTITIES");
    expect(reason).toContain("READY");
    expect(reason).toContain("IN_PROGRESS");
  });
});

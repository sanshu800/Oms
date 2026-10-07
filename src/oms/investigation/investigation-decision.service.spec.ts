import { describe, expect, it } from "vitest";

import { InvestigationDecisionService } from "./investigation-decision.service";

describe("InvestigationDecisionService", () => {
  const service = new InvestigationDecisionService();

  it("should allow reservation release for failed-order-with-reservation", () => {
    const result = service.decide({
      category: "ORDER_INTEGRITY",
      fingerprint: "failed-order-with-reservation:order-1",
    });

    expect(result).toEqual({
      action: "RELEASE_ORDER_RESERVATION",
      safe: true,
      reason: "Known safe deterministic reservation-release strategy",
    });
  });

  it("should allow reservation release for active reservation after fulfillment", () => {
    const result = service.decide({
      category: "ORDER_INTEGRITY",
      fingerprint:
        "order-active-reservation-after-fulfillment:order-2",
    });

    expect(result.action).toBe("RELEASE_ORDER_RESERVATION");
    expect(result.safe).toBe(true);
  });

  it("should block unsupported exception types", () => {
    const result = service.decide({
      category: "INVENTORY_INTEGRITY",
      fingerprint: "inventory-negative:item-1:location-1",
    });

    expect(result).toEqual({
      action: "MANUAL_INVESTIGATION_REQUIRED",
      safe: false,
      reason: "No safe deterministic resolution strategy exists",
    });
  });

  it("should block the same fingerprint when the category is not ORDER_INTEGRITY", () => {
    const result = service.decide({
      category: "ORDER_OPERATIONAL_RISK",
      fingerprint: "failed-order-with-reservation:order-3",
    });

    expect(result.action).toBe("MANUAL_INVESTIGATION_REQUIRED");
    expect(result.safe).toBe(false);
  });
});



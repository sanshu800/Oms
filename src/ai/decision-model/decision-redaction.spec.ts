import { describe, expect, it } from "vitest";

import {
  EXCERPT_MAX_CHARS,
  FORBIDDEN_STATE_SUBSTRINGS,
  TRANSMITTED_STATE_FIELDS,
  buildDecisionState,
  redactExcerpt,
} from "./decision-redaction";
import { DECISION_USE_CASES, TriageEvidence } from "./decision-model.types";

const evidence: TriageEvidence = {
  tenantId: "11111111-2222-3333-4444-555555555555",
  storeId: "66666666-7777-8888-9999-000000000000",
  orderId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  orderNumber: "#SHOP-4242",
  sku: "TSHIRT-BLACK-M",
  detectionStatus: "INSUFFICIENT_INVENTORY",
  skuKnown: true,
  requestedQty: 26,
  availableQty: 25,
  shortageQty: 1,
  inventoryIsStale: false,
  orderAgeHours: 3,
  lineItemTitle: "Black Tee (M)",
  customerNote: "Please hurry",
  priorExceptionsForSku: 2,
};

describe("decision-redaction", () => {
  it("transmits exactly the frozen allowlist per use case, nothing else", () => {
    for (const useCase of DECISION_USE_CASES) {
      const state = buildDecisionState(useCase, evidence);
      expect(Object.keys(state).sort()).toEqual(
        [...TRANSMITTED_STATE_FIELDS[useCase]].sort(),
      );
    }
  });

  it("never transmits tenant, store, order, SKU, or customer identifiers", () => {
    for (const useCase of DECISION_USE_CASES) {
      const state = buildDecisionState(useCase, evidence);
      const serialized = JSON.stringify(state);

      // The specific identifier VALUES must not leak.
      expect(serialized).not.toContain(evidence.tenantId!);
      expect(serialized).not.toContain(evidence.orderId!);
      expect(serialized).not.toContain(evidence.orderNumber!);
      expect(serialized).not.toContain(evidence.sku!);

      // No string value may carry identity-shaped tokens.
      for (const value of Object.values(state)) {
        if (typeof value !== "string") {
          continue;
        }
        expect(value).not.toMatch(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
        );
        expect(value).not.toMatch(/@/);
      }
    }
  });

  it("only URGENCY_SCORING receives text excerpts, redacted and truncated", () => {
    const longNote = `contact me at alice@example.com or ${evidence.orderId} ${"x".repeat(500)}`;
    const withLong: TriageEvidence = {
      ...evidence,
      customerNote: longNote,
    };

    const classification = buildDecisionState(
      "EXCEPTION_CLASSIFICATION",
      withLong,
    );
    expect(Object.keys(classification)).not.toContain("customerNoteExcerpt");

    const urgency = buildDecisionState("URGENCY_SCORING", withLong);
    const excerpt = urgency.customerNoteExcerpt as string;

    expect(excerpt).not.toContain("alice@example.com");
    expect(excerpt).toContain("[redacted-email]");
    expect(excerpt).not.toContain(evidence.orderId);
    expect(excerpt).toContain("[redacted-id]");
    expect(excerpt.length).toBeLessThanOrEqual(EXCERPT_MAX_CHARS + 1);
  });

  it("redactExcerpt keeps short clean text intact and null as null", () => {
    expect(redactExcerpt(null)).toBeNull();
    expect(redactExcerpt("  plain\n\nnote  ")).toBe("plain note");
  });

  it("state keys contain no forbidden identifier names (frozen allowlist sanity)", () => {
    // Two documented exceptions: `skuKnown` (boolean derived fact) and
    // `priorExceptionsForSku` (a count) mention "sku" but carry no SKU
    // value. Everything else must not even be named alike.
    const documentedExceptions = new Set([
      "skuKnown",
      "priorExceptionsForSku",
    ]);

    for (const useCase of DECISION_USE_CASES) {
      for (const field of TRANSMITTED_STATE_FIELDS[useCase]) {
        if (documentedExceptions.has(field)) {
          continue;
        }

        for (const forbidden of FORBIDDEN_STATE_SUBSTRINGS) {
          expect(field.toLowerCase()).not.toContain(forbidden.toLowerCase());
        }
      }
    }
  });
});

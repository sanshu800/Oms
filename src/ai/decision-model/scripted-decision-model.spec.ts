import { describe, expect, it } from "vitest";

import { ScriptedDecisionModel } from "./scripted-decision-model";
import { TriageEvidence } from "./decision-model.types";

const evidence: TriageEvidence = {
  detectionStatus: "INSUFFICIENT_INVENTORY",
  skuKnown: true,
  requestedQty: 26,
  availableQty: 25,
  shortageQty: 1,
  inventoryIsStale: false,
  orderAgeHours: 3,
  lineItemTitle: null,
  customerNote: null,
  priorExceptionsForSku: 0,
};

describe("ScriptedDecisionModel", () => {
  it("returns scripted answers FIFO and records calls", async () => {
    const double = new ScriptedDecisionModel();
    double
      .script("EXCEPTION_CLASSIFICATION", {
        kind: "answer",
        answer: {
          kind: "choice",
          choice: "INSUFFICIENT_INVENTORY",
          probabilities: { INSUFFICIENT_INVENTORY: 1 },
          confidence: 0.9,
        },
      })
      .script("EXCEPTION_CLASSIFICATION", {
        kind: "answer",
        answer: {
          kind: "choice",
          choice: "ZERO_AVAILABILITY",
          probabilities: { ZERO_AVAILABILITY: 1 },
          confidence: 0.4,
        },
      });

    const first = await double.decide({
      useCase: "EXCEPTION_CLASSIFICATION",
      evidence,
    });
    const second = await double.decide({
      useCase: "EXCEPTION_CLASSIFICATION",
      evidence,
    });

    expect(first.status).toBe("OK");
    if (first.status !== "OK") throw new Error("unreachable");
    expect(first.answer.kind === "choice" && first.answer.choice).toBe(
      "INSUFFICIENT_INVENTORY",
    );
    expect(first.lowConfidence).toBe(false);

    expect(second.status).toBe("OK");
    if (second.status !== "OK") throw new Error("unreachable");
    expect(second.lowConfidence).toBe(true);
    expect(double.calls.length).toBe(2);
  });

  it("returns explicit failure statuses from scripts, never a fallback answer", async () => {
    const double = new ScriptedDecisionModel();
    double.script("URGENCY_SCORING", {
      kind: "failure",
      status: "TIMEOUT",
    });

    const outcome = await double.decide({
      useCase: "URGENCY_SCORING",
      evidence,
    });

    expect(outcome.status).toBe("TIMEOUT");
    expect("answer" in outcome).toBe(false);
  });

  it("returns UNAVAILABLE when unscripted — no invented decision", async () => {
    const double = new ScriptedDecisionModel();

    const outcome = await double.decide({
      useCase: "INVESTIGATION_PATH_ROUTING",
      evidence,
    });

    expect(outcome.status).toBe("UNAVAILABLE");
    expect("answer" in outcome).toBe(false);
  });

  it("validates scripted answers through the same wire schemas (bad fixtures fail loudly)", async () => {
    const double = new ScriptedDecisionModel();
    double.script("EXCEPTION_CLASSIFICATION", {
      kind: "answer",
      answer: {
        kind: "choice",
        choice: "NOT_A_REAL_OPTION" as never,
        probabilities: {},
        confidence: 2,
      },
    });

    const outcome = await double.decide({
      useCase: "EXCEPTION_CLASSIFICATION",
      evidence,
    });

    expect(outcome.status).toBe("VALIDATION_FAILED");
  });
});

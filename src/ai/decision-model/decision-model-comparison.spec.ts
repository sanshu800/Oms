import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  baselinePredictions,
  checkFixtureIntegrity,
  enginePredictions,
  evaluateClassification,
  evaluateRouting,
  evaluateUrgency,
  loadLabelsFile,
  loadAnswersFile,
  scriptedModelFromAnswers,
  CasePrediction,
  LabelCase,
} from "../../../decision-model-comparison-run";
import { ScriptedDecisionModel } from "./scripted-decision-model";

const LABELS_PATH = "fixtures/decision-model/exception-triage.labels.json";
const ANSWERS_PATH = "fixtures/decision-model/scripted-answers.golden.json";

const cases = loadLabelsFile(LABELS_PATH);

describe("decision-model comparison runner", () => {
  it("fixture integrity: disjoint splits, no evidence-hash collisions, no near-duplicate leakage", () => {
    const integrity = checkFixtureIntegrity(cases);

    expect(integrity.violations).toEqual([]);
    expect(integrity.ok).toBe(true);
    expect(cases.filter((c) => c.split === "dev").length).toBe(16);
    expect(cases.filter((c) => c.split === "holdout").length).toBe(16);
  });

  it("catches injected cross-split leakage (duplicate + near-duplicate)", () => {
    const devCase = cases.find((c) => c.id === "dev-01")!;
    const leaked: LabelCase[] = [
      ...cases,
      {
        ...devCase,
        id: "holdout-leak-exact",
        split: "holdout",
      },
      {
        ...devCase,
        id: "holdout-leak-near",
        split: "holdout",
        evidence: {
          ...devCase.evidence,
          orderId: "different-order",
          customerNote: "Please hurry if possible",
        },
      },
    ];

    const integrity = checkFixtureIntegrity(leaked);
    expect(integrity.ok).toBe(false);
    expect(
      integrity.violations.some((v) => v.includes("identical evidence hash")),
    ).toBe(true);
    expect(
      integrity.violations.some((v) => v.includes("near-duplicate")),
    ).toBe(true);
  });

  it("baseline reproduces today's deterministic behavior on the pilot set", () => {
    const baseline = baselinePredictions(cases);

    // Classification: labels follow the facts → detector logic is perfect here.
    const classification = evaluateClassification(cases, baseline);
    expect(classification.accuracy).toBe(1);

    // Urgency: flat HIGH (3) except FULFILLABLE→0 — the current system does
    // not differentiate. Exact numbers pinned for regression
    // (sum |3-band| = 40 across 32 cases; the three FULFILLABLE cases
    // predict 0 with 0 error, so baseline sum = 31).
    const urgency = evaluateUrgency(cases, baseline);
    expect(urgency.mae).toBeCloseTo(31 / 32, 5); // 0.96875
    expect(urgency.safetyUrgencyDowngrades).toBe(0);

    // Routing: heuristic baseline misses the four TENANT_MEMORY cases.
    const routing = evaluateRouting(cases, baseline);
    expect(routing.hitRate).toBeCloseTo(28 / 32, 5); // 0.875
  });

  it("golden scripted engine reproduces the pinned comparison numbers (pipeline regression)", async () => {
    const model = scriptedModelFromAnswers(loadAnswersFile(ANSWERS_PATH), cases);
    const predictions = await enginePredictions(model, cases);

    const classificationAll = evaluateClassification(cases, predictions);
    expect(classificationAll.accuracy).toBeCloseTo(30 / 32, 5); // 0.9375
    expect(
      evaluateClassification(
        cases.filter((c) => c.split === "dev"),
        predictions,
      ).accuracy,
    ).toBeCloseTo(15 / 16, 5);
    expect(
      evaluateClassification(
        cases.filter((c) => c.split === "holdout"),
        predictions,
      ).accuracy,
    ).toBeCloseTo(15 / 16, 5);

    const urgencyAll = evaluateUrgency(cases, predictions);
    expect(urgencyAll.mae).toBeCloseTo(40 / 32, 5); // flat-3: 1.25
    expect(urgencyAll.bandAccuracy).toBeCloseTo(7 / 32, 5);
    expect(urgencyAll.withinOne).toBeCloseTo(20 / 32, 5);
    expect(urgencyAll.safetyUrgencyDowngrades).toBe(0);

    const routingAll = evaluateRouting(cases, predictions);
    expect(routingAll.hitRate).toBeCloseTo(29 / 32, 5); // 0.90625
    expect(
      evaluateRouting(
        cases.filter((c) => c.split === "holdout"),
        predictions,
      ).hitRate,
    ).toBeCloseTo(14 / 16, 5);
  });

  it("engine failures are recorded as failures, never as invented decisions", async () => {
    const unscripted = new ScriptedDecisionModel();
    const predictions = await enginePredictions(unscripted, cases);

    for (const prediction of predictions.values() as Iterable<CasePrediction>) {
      expect(prediction.classification).toBeNull();
      expect(prediction.urgencyScore).toBeNull();
      expect(prediction.routing).toBeNull();
      expect(prediction.failures.length).toBe(3);
    }

    const classification = evaluateClassification(cases, predictions);
    expect(classification.evaluated).toBe(0);
    expect(classification.accuracy).toBeNull();
  });

  it("the golden answers fixture is marked synthetic — it is not evidence about Jev", () => {
    const raw = JSON.parse(
      readFileSync(ANSWERS_PATH, "utf8"),
    ) as { _meta: { synthetic: boolean; warning: string } };

    expect(raw._meta.synthetic).toBe(true);
    expect(raw._meta.warning).toMatch(/Never use these numbers to judge Jev/);
  });
});

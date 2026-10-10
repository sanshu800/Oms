/**
 * Offline DecisionModel comparison runner (labelled examples vs the
 * existing deterministic baseline vs a candidate engine).
 *
 * Reproducibility rules enforced here:
 *  - Labels are human-authored and independent of any model output (see
 *    the fixture _meta.labelProvenance).
 *  - dev/holdout ids must be disjoint; canonical evidence hashes must not
 *    collide across splits; cross-split text near-duplicates (token
 *    Jaccard > 0.9) fail the run. No leakage, no overlap.
 *  - The pilot scale (32 cases) is INITIAL PILOT evidence only. Passing
 *    permits further shadow evaluation, never production enablement.
 *
 * Engines:
 *   --engine=none      (default) baseline-only comparison
 *   --engine=scripted --answers=<file>  deterministic double fed from a
 *                       fixture (regression mode; golden file included)
 *   --engine=jev       live Jev — REFUSES without --allow-live. Never
 *                       exercised in development or tests (no live calls).
 *
 * No claim about Jev's accuracy, speed, or cost is made by this tool or
 * its outputs unless a real provider produced the numbers.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";

import { z } from "zod";

import {
  CLASSIFICATION_OPTIONS,
  DecisionOutcome,
  DecisionRequest,
  ROUTING_PLANS,
  TriageEvidence,
  UrgencyBand,
} from "./src/ai/decision-model/decision-model.types";
import {
  baselineClassification,
  baselineRoutingPlan,
  baselineUrgencyBand,
} from "./src/ai/decision-model/decision-baseline";
import { DecisionModel } from "./src/ai/decision-model/decision-model.interface";
import { ScriptedDecisionModel } from "./src/ai/decision-model/scripted-decision-model";
import { JevDecisionModelClient } from "./src/ai/decision-model/jev-decision-model.client";

// ---------------------------------------------------------------------------
// Fixture schema
// ---------------------------------------------------------------------------

const classificationSchema = z.enum(CLASSIFICATION_OPTIONS);
const routingSchema = z.enum(ROUTING_PLANS);

export const labelCaseSchema = z.object({
  id: z.string().min(1),
  split: z.enum(["dev", "holdout"]),
  evidence: z.object({
    tenantId: z.string(),
    storeId: z.string(),
    orderId: z.string(),
    orderNumber: z.string(),
    sku: z.string(),
    detectionStatus: classificationSchema,
    skuKnown: z.boolean(),
    requestedQty: z.number(),
    availableQty: z.number().nullable(),
    shortageQty: z.number(),
    inventoryIsStale: z.boolean(),
    orderAgeHours: z.number(),
    lineItemTitle: z.string().nullable(),
    customerNote: z.string().nullable(),
    priorExceptionsForSku: z.number(),
  }),
  labels: z.object({
    classification: classificationSchema,
    urgencyBand: z.number().int().min(0).max(3),
    preferredPath: routingSchema,
  }),
  notes: z.string().optional(),
});

export type LabelCase = z.infer<typeof labelCaseSchema>;

export const labelsFileSchema = z.object({
  _meta: z.record(z.string(), z.unknown()),
  cases: z.array(labelCaseSchema).min(1),
});

export const answersFileSchema = z.object({
  _meta: z.record(z.string(), z.unknown()).optional(),
  answers: z.record(
    z.string(),
    z.object({
      classification: classificationSchema,
      urgencyScore: z.number(),
      routing: routingSchema,
      confidence: z.number().min(0).max(1),
    }),
  ),
});

export type CasePrediction = {
  classification: string | null;
  urgencyScore: number | null;
  routing: string | null;
  failures: string[];
};

// ---------------------------------------------------------------------------
// Integrity: no overlap, no near-duplicate leakage across splits
// ---------------------------------------------------------------------------

function canonicalEvidenceHash(evidence: LabelCase["evidence"]): string {
  const {
    tenantId: _t,
    storeId: _s,
    orderId: _o,
    orderNumber: _n,
    sku: _k,
    ...facts
  } = evidence;

  return createHash("sha256")
    .update(JSON.stringify(facts, Object.keys(facts).sort()))
    .digest("hex");
}

function textTokens(evidence: LabelCase["evidence"]): Set<string> {
  const text = `${evidence.lineItemTitle ?? ""} ${evidence.customerNote ?? ""}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  return new Set(text === "" ? [] : text.split(" "));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) {
    return 0;
  }

  let intersection = 0;

  for (const token of a) {
    if (b.has(token)) {
      intersection += 1;
    }
  }

  return intersection / (a.size + b.size - intersection);
}

export const NEAR_DUPLICATE_JACCARD_LIMIT = 0.9;

export function checkFixtureIntegrity(cases: LabelCase[]): {
  ok: boolean;
  violations: string[];
} {
  const violations: string[] = [];
  const ids = new Set<string>();

  for (const testCase of cases) {
    if (ids.has(testCase.id)) {
      violations.push(`duplicate case id ${testCase.id}`);
    }

    ids.add(testCase.id);
  }

  const dev = cases.filter((testCase) => testCase.split === "dev");
  const holdout = cases.filter((testCase) => testCase.split === "holdout");

  if (dev.length === 0 || holdout.length === 0) {
    violations.push("both splits must be non-empty");
  }

  const hashes = new Map<string, string[]>();

  for (const testCase of cases) {
    const hash = canonicalEvidenceHash(testCase.evidence);
    const owners = hashes.get(hash) ?? [];
    owners.push(`${testCase.id}(${testCase.split})`);
    hashes.set(hash, owners);
  }

  for (const [, owners] of hashes) {
    const splits = new Set(
      owners.map((owner) => owner.includes("holdout") ? "holdout" : "dev"),
    );

    if (owners.length > 1 && splits.size > 1) {
      violations.push(
        `identical evidence hash across splits: ${owners.join(", ")}`,
      );
    }
  }

  for (const devCase of dev) {
    for (const holdoutCase of holdout) {
      const similarity = jaccard(
        textTokens(devCase.evidence),
        textTokens(holdoutCase.evidence),
      );

      if (similarity > NEAR_DUPLICATE_JACCARD_LIMIT) {
        violations.push(
          `near-duplicate text across splits (${similarity.toFixed(2)}): ${devCase.id} ~ ${holdoutCase.id}`,
        );
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export function evaluateClassification(
  cases: LabelCase[],
  predictions: Map<string, CasePrediction>,
): {
  evaluated: number;
  accuracy: number | null;
  perClassRecall: Record<string, number | null>;
  confusion: Record<string, Record<string, number>>;
} {
  const confusion: Record<string, Record<string, number>> = {};
  let correct = 0;
  let evaluated = 0;

  for (const testCase of cases) {
    const prediction = predictions.get(testCase.id)?.classification;

    if (prediction === null || prediction === undefined) {
      continue;
    }

    evaluated += 1;
    const label = testCase.labels.classification;
    confusion[label] ??= {};
    confusion[label][prediction] = (confusion[label][prediction] ?? 0) + 1;

    if (prediction === label) {
      correct += 1;
    }
  }

  const perClassRecall: Record<string, number | null> = {};

  for (const option of CLASSIFICATION_OPTIONS) {
    const row = confusion[option];
    const total = row
      ? Object.values(row).reduce((sum, count) => sum + count, 0)
      : 0;
    const correctForOption = row?.[option] ?? 0;

    perClassRecall[option] =
      total === 0 ? null : correctForOption / total;
  }

  return {
    evaluated,
    accuracy: evaluated === 0 ? null : correct / evaluated,
    perClassRecall,
    confusion,
  };
}

export function evaluateUrgency(
  cases: LabelCase[],
  predictions: Map<string, CasePrediction>,
): {
  evaluated: number;
  mae: number | null;
  bandAccuracy: number | null;
  withinOne: number | null;
  safetyUrgencyDowngrades: number;
  downgradedCaseIds: string[];
} {
  let evaluated = 0;
  let absoluteErrorSum = 0;
  let bandHits = 0;
  let withinOne = 0;
  const downgradedCaseIds: string[] = [];

  for (const testCase of cases) {
    const score = predictions.get(testCase.id)?.urgencyScore;

    if (score === null || score === undefined) {
      continue;
    }

    evaluated += 1;
    const band = testCase.labels.urgencyBand;
    absoluteErrorSum += Math.abs(score - band);

    const rounded = Math.round(score) as UrgencyBand;

    if (rounded === band) {
      bandHits += 1;
    }

    if (Math.abs(score - band) <= 1) {
      withinOne += 1;
    }

    // Pre-declared safety class: a label at the top band must never be
    // predicted below that band (no silent de-escalation of criticals).
    if (band === 3 && rounded < 3) {
      downgradedCaseIds.push(testCase.id);
    }
  }

  return {
    evaluated,
    mae: evaluated === 0 ? null : absoluteErrorSum / evaluated,
    bandAccuracy: evaluated === 0 ? null : bandHits / evaluated,
    withinOne: evaluated === 0 ? null : withinOne / evaluated,
    safetyUrgencyDowngrades: downgradedCaseIds.length,
    downgradedCaseIds,
  };
}

export function evaluateRouting(
  cases: LabelCase[],
  predictions: Map<string, CasePrediction>,
): { evaluated: number; hitRate: number | null } {
  let evaluated = 0;
  let hits = 0;

  for (const testCase of cases) {
    const routing = predictions.get(testCase.id)?.routing;

    if (routing === null || routing === undefined) {
      continue;
    }

    evaluated += 1;

    if (routing === testCase.labels.preferredPath) {
      hits += 1;
    }
  }

  return {
    evaluated,
    hitRate: evaluated === 0 ? null : hits / evaluated,
  };
}

export function baselinePredictions(
  cases: LabelCase[],
): Map<string, CasePrediction> {
  const predictions = new Map<string, CasePrediction>();

  for (const testCase of cases) {
    const evidence: TriageEvidence = testCase.evidence;
    predictions.set(testCase.id, {
      classification: baselineClassification(evidence),
      urgencyScore: baselineUrgencyBand(evidence),
      routing: baselineRoutingPlan(evidence),
      failures: [],
    });
  }

  return predictions;
}

// ---------------------------------------------------------------------------
// Engine evaluation
// ---------------------------------------------------------------------------

export async function enginePredictions(
  model: DecisionModel,
  cases: LabelCase[],
): Promise<Map<string, CasePrediction>> {
  const predictions = new Map<string, CasePrediction>();

  for (const testCase of cases) {
    const prediction: CasePrediction = {
      classification: null,
      urgencyScore: null,
      routing: null,
      failures: [],
    };

    const collect = (useCase: DecisionRequest["useCase"], outcome: DecisionOutcome) => {
      if (outcome.status !== "OK") {
        prediction.failures.push(`${useCase}:${outcome.status}`);
        return;
      }

      if (outcome.answer.kind === "choice") {
        if (useCase === "EXCEPTION_CLASSIFICATION") {
          prediction.classification = outcome.answer.choice;
        } else {
          prediction.routing = outcome.answer.choice;
        }
      } else {
        prediction.urgencyScore = outcome.answer.score;
      }
    };

    collect(
      "EXCEPTION_CLASSIFICATION",
      await model.decide({
        useCase: "EXCEPTION_CLASSIFICATION",
        evidence: testCase.evidence,
      }),
    );
    collect(
      "URGENCY_SCORING",
      await model.decide({
        useCase: "URGENCY_SCORING",
        evidence: testCase.evidence,
      }),
    );
    collect(
      "INVESTIGATION_PATH_ROUTING",
      await model.decide({
        useCase: "INVESTIGATION_PATH_ROUTING",
        evidence: testCase.evidence,
      }),
    );

    predictions.set(testCase.id, prediction);
  }

  return predictions;
}

export function loadLabelsFile(filePath: string): LabelCase[] {
  const raw = JSON.parse(readFileSync(filePath, "utf8"));
  return labelsFileSchema.parse(raw).cases;
}

export function loadAnswersFile(filePath: string): Map<
  string,
  { classification: string; urgencyScore: number; routing: string; confidence: number }
> {
  const raw = JSON.parse(readFileSync(filePath, "utf8"));
  return new Map(Object.entries(answersFileSchema.parse(raw).answers));
}

export function scriptedModelFromAnswers(
  answers: Map<string, { classification: string; urgencyScore: number; routing: string; confidence: number }>,
  cases: LabelCase[],
): ScriptedDecisionModel {
  const model = new ScriptedDecisionModel();

  // Script in case order so the FIFO double matches per-case calls.
  for (const testCase of cases) {
    const answer = answers.get(testCase.id);

    if (!answer) {
      throw new Error(`answers file is missing case ${testCase.id}`);
    }

    model.script("EXCEPTION_CLASSIFICATION", {
      kind: "answer",
      answer: {
        kind: "choice",
        choice: answer.classification as never,
        probabilities: { [answer.classification]: 1 },
        confidence: answer.confidence,
      },
    });
    model.script("URGENCY_SCORING", {
      kind: "answer",
      answer: {
        kind: "score",
        score: answer.urgencyScore,
        probabilities: {},
        legend: {},
        confidence: answer.confidence,
      },
    });
    model.script("INVESTIGATION_PATH_ROUTING", {
      kind: "answer",
      answer: {
        kind: "choice",
        choice: answer.routing as never,
        probabilities: { [answer.routing]: 1 },
        confidence: answer.confidence,
      },
    });
  }

  return model;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function arg(name: string, fallback: string): string {
  const match = process.argv.find((value) => value.startsWith(`--${name}=`));
  return match ? match.split("=").slice(1).join("=") : fallback;
}

async function main() {
  const engineName = arg("engine", "none");
  const allowLive = process.argv.includes("--allow-live");
  const labelsPath = path.resolve(
    arg("labels", "fixtures/decision-model/exception-triage.labels.json"),
  );
  const splitFilter = arg("split", "all");

  const allCases = loadLabelsFile(labelsPath);
  const integrity = checkFixtureIntegrity(allCases);

  const cases =
    splitFilter === "all"
      ? allCases
      : allCases.filter((testCase) => testCase.split === splitFilter);

  const bySplit = (name: "all" | "dev" | "holdout") =>
    name === "all" ? allCases : allCases.filter((testCase) => testCase.split === name);

  const baseline = baselinePredictions(allCases);

  const report: Record<string, unknown> = {
    result: integrity.ok ? "PASS" : "FAIL",
    fixture: {
      labelsPath,
      cases: allCases.length,
      integrity,
      splitCounts: {
        dev: bySplit("dev").length,
        holdout: bySplit("holdout").length,
      },
    },
    realProviderCalled: false,
    pilotNotice:
      "32-case pilot only — not statistically conclusive. Passing permits further shadow evaluation, never production enablement.",
  };

  const metricsFor = (
    predictions: Map<string, CasePrediction>,
  ): Record<string, unknown> => ({
    all: {
      classification: evaluateClassification(bySplit("all"), predictions),
      urgency: evaluateUrgency(bySplit("all"), predictions),
      routing: evaluateRouting(bySplit("all"), predictions),
    },
    dev: {
      classification: evaluateClassification(bySplit("dev"), predictions),
      urgency: evaluateUrgency(bySplit("dev"), predictions),
      routing: evaluateRouting(bySplit("dev"), predictions),
    },
    holdout: {
      classification: evaluateClassification(bySplit("holdout"), predictions),
      urgency: evaluateUrgency(bySplit("holdout"), predictions),
      routing: evaluateRouting(bySplit("holdout"), predictions),
    },
  });

  report.baseline = { vsLabels: metricsFor(baseline) };

  let enginePredictionsMap: Map<string, CasePrediction> | null = null;

  if (engineName === "scripted") {
    const answersPath = path.resolve(
      arg("answers", "fixtures/decision-model/scripted-answers.golden.json"),
    );

    const model = scriptedModelFromAnswers(
      loadAnswersFile(answersPath),
      allCases,
    );
    enginePredictionsMap = await enginePredictions(model, cases);

    report.engine = {
      name: `scripted (${path.basename(answersPath)})`,
      synthetic: true,
      note: "Synthetic regression fixture — never evidence about Jev.",
      vsLabels: metricsFor(enginePredictionsMap),
    };
  } else if (engineName === "jev") {
    if (!allowLive) {
      report.engine = {
        name: "jev",
        vsLabels: "UNAVAILABLE",
        error:
          "Live Jev runs require --allow-live AND JEV_API_KEY. No live API calls are made by default.",
      };
      report.realProviderCalled = false;
    } else {
      const model = new JevDecisionModelClient({
        apiKey: process.env.JEV_API_KEY,
        baseUrl: process.env.JEV_API_URL,
        model: process.env.JEV_MODEL,
      });
      enginePredictionsMap = await enginePredictions(model, cases);
      report.realProviderCalled = true;
      report.engine = {
        name: "jev",
        vsLabels: metricsFor(enginePredictionsMap),
      };
    }
  } else {
    report.engine = {
      name: "none",
      vsLabels: "UNAVAILABLE",
      note: "Baseline-only run. Candidate-model metrics require --engine=scripted|jev.",
    };
  }

  // Gate assessment — REPORTED, pilot-level only.
  const holdoutBaseline = report.baseline as {
    vsLabels: Record<string, ReturnType<typeof evaluateUrgency> & { accuracy: number | null }>;
  };

  if (enginePredictionsMap) {
    const holdoutUrgency = evaluateUrgency(bySplit("holdout"), enginePredictionsMap);
    const holdoutClassification = evaluateClassification(
      bySplit("holdout"),
      enginePredictionsMap,
    );
    const baselineHoldoutClassification = evaluateClassification(
      bySplit("holdout"),
      baseline,
    );

    const zeroDowngrades = holdoutUrgency.safetyUrgencyDowngrades === 0;
    const atLeastBaseline =
      holdoutClassification.accuracy !== null &&
      baselineHoldoutClassification.accuracy !== null &&
      holdoutClassification.accuracy >= baselineHoldoutClassification.accuracy;

    report.gateAssessment = {
      scope: "holdout only; independent of dev; pilot-level",
      zeroSafetyUrgencyDowngrades: zeroDowngrades,
      classificationAtLeastBaseline: atLeastBaseline,
      eligibleForShadowEvaluation: zeroDowngrades && atLeastBaseline,
      note:
        "Eligibility permits further SHADOW EVALUATION only. Production enablement requires a separate approval after real measured results on an independent holdout. No accuracy, speed, or cost claim is made here.",
    };
  } else {
    report.gateAssessment = {
      scope: "holdout only; independent of dev; pilot-level",
      status: "UNAVAILABLE",
      note: "No candidate engine ran. Baseline numbers are the existing system's behavior.",
    };
  }

  void holdoutBaseline;

  console.log(JSON.stringify(report, null, 2));
}

const invokedDirectly = process.argv.some((value) =>
  value.includes("decision-model-comparison-run"),
);

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

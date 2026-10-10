/**
 * Real-Model Validation Harness — repeatable runner.
 *
 * Runs AI investigations over PERSISTED operational exceptions (seeded
 * through the real detection path) and scores them with the
 * provider-agnostic InvestigationEvaluationService.
 *
 * Engines (same harness, same evaluation logic, one configuration switch):
 *   --provider=scripted   (DEFAULT) deterministic ScriptedLlmClient.
 *                         No API key, no network. For regression runs.
 *   --provider=app        whatever LLM_CLIENT AppModule is configured
 *                         with (GroqLlmClient when GROQ_API_KEY is set).
 *                         NOT exercised without credentials — the code
 *                         path exists for later, and this task never
 *                         calls a live provider.
 *
 * Modes:
 *   --scenario=INVENTORY_SHORTAGE|RESERVATION_FAILURE|all   (default: all)
 *   --exception-id=<id> --tenant-id=<id> --store-id=<id>
 *         evaluate an exception that already exists in the database
 *         (scripted engine concludes NO_ACTION_INSUFFICIENT_EVIDENCE —
 *         the honest conservative default for unknown evidence).
 *
 * Safety: the harness investigates and scores only. It never approves or
 * executes proposals; inventory-changing actions remain behind explicit
 * human approval in AiDecisionService.
 *
 * Output: JSON report with per-run criteria, metrics, and explicit
 * unavailable-metric markers. Real-model accuracy is NOT reported — no
 * real model has been called.
 *
 * Run: npx ts-node ai-investigation-validation-run.ts [--scenario=all] [--provider=scripted]
 */
import { Test } from "@nestjs/testing";

import { AppModule } from "./src/app.module";
import { PrismaService } from "./src/prisma/prisma.service";
import { tenantContextStorage } from "./src/prisma/tenant-context";
import { OrderService } from "./src/oms/order/order.service";
import { AiInvestigationService } from "./src/ai/investigation/ai-investigation.service";
import { LLM_CLIENT } from "./src/ai/llm/llm-client.interface";
import { ScriptedLlmClient } from "./src/ai/validation/scripted-llm.client";
import { InvestigationEvaluationService } from "./src/ai/validation/investigation-evaluation.service";
import {
  InvestigationHarnessService,
  SCENARIO_NAMES,
  ScenarioName,
  ScenarioSeed,
} from "./src/ai/validation/investigation-harness.service";

function arg(name: string, fallback: string): string {
  const match = process.argv.find((value) => value.startsWith(`--${name}=`));
  return match ? match.split("=").slice(1).join("=") : fallback;
}

function scenarioScript(
  engine: ScriptedLlmClient,
  seed: ScenarioSeed,
): void {
  const gatherCalls =
    seed.heldOrderId !== null
      ? [
          {
            name: "get_exception_context",
            arguments: { exceptionId: seed.exceptionId },
          },
          { name: "get_inventory_truth", arguments: { sku: seed.sku } },
          { name: "get_order_detail", arguments: { orderId: seed.heldOrderId } },
        ]
      : [
          {
            name: "get_exception_context",
            arguments: { exceptionId: seed.exceptionId },
          },
          { name: "get_inventory_truth", arguments: { sku: seed.sku } },
          {
            name: "get_order_detail",
            arguments: { orderId: seed.blockedOrderId },
          },
        ];

  const conclusion =
    seed.heldOrderId !== null
      ? {
          actionType: "RELEASE_ORDER_RESERVATION",
          targetEntityType: "ORDER",
          targetEntityId: seed.heldOrderId,
          params: {},
          confidence: 0.9,
          basis: "HEURISTIC",
          riskTier: "HIGH",
          reasoningSummary:
            "The held order's reservation is blocking the new order recorded in the exception; releasing it restores availability. Recommend-only: a human must approve.",
          evidenceRefs: [seed.exceptionId, seed.heldOrderId],
        }
      : {
          actionType: "ADD_ORDER_NOTE",
          targetEntityType: "ORDER",
          targetEntityId: seed.blockedOrderId,
          params: {
            note: `TechMart: this order could not be reserved (inventory shortage on ${seed.sku}); held for operator review.`,
          },
          confidence: 0.9,
          basis: "HEURISTIC",
          riskTier: "LOW",
          reasoningSummary:
            "The order failed reservation due to insufficient inventory; a note explains the hold to the merchant.",
          evidenceRefs: [seed.exceptionId, seed.blockedOrderId],
        };

  engine.setScript([
    { toolCalls: gatherCalls },
    {
      toolCalls: [
        { name: "submit_decision_proposal", arguments: conclusion },
      ],
    },
  ]);
}

async function main() {
  const provider = arg("provider", "scripted");
  const scenarioArg = arg("scenario", "all");
  const exceptionId = arg("exception-id", "");
  const useScripted = provider === "scripted";

  if (!useScripted && provider !== "app") {
    throw new Error(`Unknown --provider=${provider} (use scripted|app)`);
  }

  const engine = useScripted ? new ScriptedLlmClient() : null;

  const builder = Test.createTestingModule({ imports: [AppModule] });

  if (useScripted && engine) {
    builder.overrideProvider(LLM_CLIENT).useValue(engine);
  }

  // With --provider=app no override is applied: the app's configured
  // LLM_CLIENT (e.g. GroqLlmClient) is what the harness runs against.
  const moduleRef = await builder.compile();
  const llmNote =
    useScripted
      ? "deterministic ScriptedLlmClient (no provider called)"
      : "app-configured LLM_CLIENT (real provider call requires credentials; not exercised by this task)";

  if (!useScripted) {
    console.error(
      "NOTE: --provider=app requires a configured LLM provider (e.g. GROQ_API_KEY). This run has NOT been validated against a live provider.",
    );
  }

  const prisma = moduleRef.get(PrismaService, { strict: false });
  const orderService = moduleRef.get(OrderService, { strict: false });
  const investigationService = moduleRef.get(AiInvestigationService, {
    strict: false,
  });

  const evaluationService = new InvestigationEvaluationService(prisma);
  const harness = new InvestigationHarnessService(
    prisma,
    orderService,
    investigationService,
    evaluationService,
  );

  const runs: unknown[] = [];
  let allPass = true;

  try {
    if (exceptionId) {
      const tenantId = arg("tenant-id", "");
      const storeId = arg("store-id", "");

      if (!tenantId || !storeId) {
        throw new Error(
          "--exception-id requires --tenant-id and --store-id",
        );
      }

      const report = await harness.runAgainstException({
        tenantId,
        storeId,
        exceptionId,
        scenario: "PERSISTED_EXCEPTION",
        prepare: () => {
          if (engine) {
            engine.setScript([
              {
                toolCalls: [
                  {
                    name: "get_exception_context",
                    arguments: { exceptionId },
                  },
                ],
              },
              {
                toolCalls: [
                  {
                    name: "submit_decision_proposal",
                    arguments: {
                      actionType: "NO_ACTION_INSUFFICIENT_EVIDENCE",
                      targetEntityType: "OPERATIONAL_EXCEPTION",
                      targetEntityId: exceptionId,
                      params: {},
                      confidence: 0.2,
                      basis: "HEURISTIC",
                      riskTier: "LOW",
                      reasoningSummary:
                        "Deterministic validation run against an existing exception: insufficient verified evidence to recommend a concrete action.",
                      evidenceRefs: [exceptionId],
                    },
                  },
                ],
              },
            ]);
          }
        },
      });

      allPass &&= report.evaluation.verdict === "PASS";
      runs.push({ ...report });
    } else {
      const scenarios: ScenarioName[] =
        scenarioArg === "all"
          ? [...SCENARIO_NAMES]
          : [scenarioArg as ScenarioName];

      for (const scenario of scenarios) {
        const report = await harness.runScenario({
          scenario,
          prepare: (seed) => {
            if (engine) {
              scenarioScript(engine, seed);
            }
          },
        });

        allPass &&= report.evaluation.verdict === "PASS";
        runs.push({
          seed: report.seed,
          investigation: report.investigation,
          evaluation: report.evaluation,
        });
      }
    }

    console.log(
      JSON.stringify(
        {
          result: allPass ? "PASS" : "FAIL",
          engine: llmNote,
          realModelAccuracyReported: false,
          realProviderCalled: false,
          note: "No live provider was called. Real-model accuracy and real-provider success are NOT reported; only harness mechanics and evaluation logic are validated here.",
          runs,
        },
        null,
        2,
      ),
    );
  } finally {
    await moduleRef.close();
  }
}

tenantContextStorage
  .run({ bypass: true }, () => main())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

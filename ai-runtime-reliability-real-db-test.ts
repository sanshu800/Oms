/**
 * ai-runtime-reliability-real-db-test.ts — Phase 2B acceptance against
 * REAL PostgreSQL + REAL RLS: investigation idempotency/concurrency,
 * abandoned-run recovery, late-response safety, and queue-exhaustion
 * durability. No live provider calls (LLM_CLIENT is overridden with a
 * deterministic double whose tool calls still execute FOR REAL).
 *
 * Scenarios:
 *   S1  concurrent duplicate dispatch → ONE authoritative row + ONE proposal
 *   S2  resume of an abandoned RUNNING row (simulated crash) → same row,
 *       no duplicate record, exactly one proposal
 *   S3  recovery sweep: eligible → redispatch+audit; recovery-capped and
 *       over-age → bounded terminal FAILED + audit; recovered run cannot
 *       duplicate proposals
 *   S4  late provider response after cancellation → no proposal, single
 *       terminal outcome
 *   S5  completed investigation + a NEW dispatch → new row allowed (real
 *       re-investigation), old row keeps exactly one proposal
 *   S6  tenant/store scope separation → concurrent runs in different
 *       stores are never coalesced
 *   S7  retry exhaustion writes a durable audit record (dead-letter
 *       visibility), kept even though the job rethrows
 *
 * Run: npx ts-node ai-runtime-reliability-real-db-test.ts
 */
import { Test } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bullmq";

import { AppModule } from "./src/app.module";
import { PrismaService } from "./src/prisma/prisma.service";
import { tenantContextStorage } from "./src/prisma/tenant-context";
import { encryptSecret } from "./src/shopify/shopify-auth.crypto";
import { AuditService } from "./src/oms/audit/audit.service";
import { ExceptionService } from "./src/oms/exception/exception.service";
import {
  AiInvestigationService,
  AiRecoverySweepResult,
} from "./src/ai/investigation/ai-investigation.service";
import {
  AI_INVESTIGATION_JOB,
  AI_RECOVERY_JOB,
} from "./src/ai/queue/ai-investigation.queue";
import { AiInvestigationWorker } from "./src/ai/queue/ai-investigation.worker";
import {
  LLM_CLIENT,
  LlmChatCompletionInput,
  LlmChatCompletionResult,
  LlmClient,
} from "./src/ai/llm/llm-client.interface";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`TEST FAILED: ${message}`);
  }
}

// ============================================================
// Controllable LLM double: scripted turns, or parked calls that a
// test can resolve LATE (to prove a late response can never publish).
// ============================================================

type ScriptedTurn = {
  content?: string;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
};

function turnToResult(turn: ScriptedTurn): LlmChatCompletionResult {
  return {
    message: {
      role: "assistant",
      content: turn.content ?? null,
      toolCalls: turn.toolCalls.map((call, index) => ({
        id: `call-${Date.now()}-${index}`,
        name: call.name,
        arguments: call.arguments,
      })),
    },
    tokensUsed: 10,
  };
}

class ControllableLlm implements LlmClient {
  private scriptQueue: ScriptedTurn[] = [];
  private parked: Array<{
    resolve: (result: LlmChatCompletionResult) => void;
    input: LlmChatCompletionInput;
  }> = [];

  setScript(turns: ScriptedTurn[]) {
    this.scriptQueue.push(...turns);
  }

  releaseNext(turn: ScriptedTurn): boolean {
    const next = this.parked.shift();
    next?.resolve(turnToResult(turn));
    return Boolean(next);
  }

  /** Resolve every parked call with a grounded submit for ITS OWN
   *  exception (deterministic under concurrency). */
  autoReleaseAll(): number {
    const released = this.parked.length;

    for (const entry of this.parked.splice(0)) {
      const user = entry.input.messages.find((m) => m.role === "user");
      const match = /exception ([0-9a-fA-F-]+)/.exec(user?.content ?? "");
      entry.resolve(turnToResult(escalateTurn((match?.[1] as string) ?? "")));
    }

    return released;
  }

  get parkedCount(): number {
    return this.parked.length;
  }

  async createChatCompletion(
    input: LlmChatCompletionInput,
  ): Promise<LlmChatCompletionResult> {
    const scripted = this.scriptQueue.shift();

    if (scripted) {
      return turnToResult(scripted);
    }

    if (input.signal?.aborted) {
      throw new Error("Provider call cancelled before dispatch");
    }

    // Park until the test releases a turn (or never — cancellation).
    return new Promise((resolve) => {
      this.parked.push({ resolve, input });
    });
  }
}

/** Grounded uncertainty submit targeting the run's own exception. */
function escalateTurn(exceptionId: string): ScriptedTurn {
  return {
    toolCalls: [
      {
        name: "submit_decision_proposal",
        arguments: {
          actionType: "ESCALATE_TO_HUMAN",
          targetEntityType: "OPERATIONAL_EXCEPTION",
          targetEntityId: exceptionId,
          params: {},
          confidence: 0.7,
          basis: "HEURISTIC",
          riskTier: "LOW",
          reasoningSummary: "Escalating after review of the available evidence.",
          evidenceRefs: [],
        },
      },
    ],
  };
}

/** Per-call auto-pilot: any parked turn becomes a grounded submit for the
 *  exception named in that call's prompt. */
async function pumpUntilSettled<T>(
  llm: ControllableLlm,
  promises: Promise<T>[],
  timeoutMs = 15_000,
): Promise<T[]> {
  let settled = false;

  const outcome = Promise.all(promises).then((values) => {
    settled = true;

    return values;
  });

  const deadline = Date.now() + timeoutMs;

  while (!settled && Date.now() < deadline) {
    llm.autoReleaseAll();
    await sleep(25);
  }

  return outcome;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  console.log("[BOOT] main() entered");
  // Short, bounded run timeout for the reliability scenarios (S4 depends
  // on a prompt cancellation). process.env takes precedence over .env.
  process.env.AI_INVESTIGATION_TIMEOUT_MS = "3000";

  const llm = new ControllableLlm();

  console.log("[BOOT] compiling module …");
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(LLM_CLIENT)
    .useValue(llm)
    // The broker handle is replaced with an in-memory stub: this suite
    // verifies DATABASE/PERSISTENCE semantics (claims, leases, recovery),
    // and BullMQ job-option/dedup semantics are pinned by the unit specs.
    // (The sandbox has no Redis; a real Queue.add would block forever on
    // its reconnect loop.)
    .overrideProvider(getQueueToken("ai-investigation"))
    .useValue({
      add: async () => ({}),
      on: () => undefined,
      close: async () => undefined,
    })
    .compile();

  console.log("[BOOT] module compiled");
  const app = moduleRef;

  const prisma = app.get(PrismaService, { strict: false });
  const exceptionService = app.get(ExceptionService, { strict: false });
  const investigationService = app.get(AiInvestigationService, {
    strict: false,
  });
  const auditService = app.get(AuditService, { strict: false });

  try {
    // ---------- seed: one tenant, two stores, six exceptions ----------
    const tenant = await prisma.runAsSystem(() =>
      prisma.tenant.create({ data: { name: `relia-${Date.now()}` } }),
    );

    const makeStore = async (label: string) =>
      prisma.runAsSystem(() =>
        prisma.storeConnection.create({
          data: {
            tenantId: tenant.id,
            externalStoreId: `${label}-${Date.now()}.myshopify.com`,
            platform: "SHOPIFY",
            status: "ACTIVE",
            encryptedAccessToken: encryptSecret(
              "fake-token",
              "reliability-test-encryption-secret-32b",
            ),
            scopes: ["read_orders"],
          },
        }),
      );

    const storeA = await makeStore("relia-a");
    const storeB = await makeStore("relia-b");

    const makeException = async (
      store: { id: string },
      label: string,
    ) =>
      prisma.runAsTenant(tenant.id, () =>
        exceptionService.createOrUpdateException({
          tenantId: tenant.id,
          storeId: store.id,
          fingerprint: `relia-${label}-${Date.now()}`,
          category: "INVENTORY_SHORTAGE",
          severity: "HIGH" as never,
          title: `Reliability ${label}`,
          evidence: { sku: "sku-managed-1" },
          recommendedNextStep: "investigate",
        }),
      );

    console.log("[SEED] tenant + stores done");
    const exc1 = await makeException(storeA, "concurrent");
    console.log("[SEED] exc1 done");
    const exc2 = await makeException(storeA, "resume");
    console.log("[SEED] exc2 done");
    const exc3 = await makeException(storeA, "sweep-eligible");
    const exc4 = await makeException(storeA, "sweep-capped");
    const exc5 = await makeException(storeA, "sweep-overage");
    const exc6 = await makeException(storeB, "scope-b");
    console.log("[SEED] all exceptions done");

    const scopeCount = async (exceptionId: string) =>
      prisma.runAsSystem(() =>
        prisma.aiInvestigation.count({
          where: { tenantId: tenant.id, exceptionId },
        }),
      );

    const proposalCount = async (investigationId: string) =>
      prisma.runAsSystem(() =>
        prisma.aiDecisionProposal.count({ where: { investigationId } }),
      );

    console.log("[S1] start");
    // ---------- S1: concurrent duplicate dispatch ----------
    {
      const dispatch = () =>
        prisma.runAsTenant(tenant.id, () =>
          investigationService.investigate({
            tenantId: tenant.id,
            storeId: storeA.id,
            exceptionId: exc1.id,
          }),
        );

      const p1 = dispatch();
      const p2 = dispatch();

      const [a, b] = await pumpUntilSettled(llm, [p1, p2]);
      assert(a && b, "S1: both concurrent dispatches settled");

      const [first, second] = [a, b];
      assert(
        first.investigationId === second.investigationId,
        `concurrent dispatches must share one authoritative row (got ${first.investigationId} / ${second.investigationId})`,
      );
      assert(
        (first.attachedToActiveRun ?? false) !==
          (second.attachedToActiveRun ?? false),
        "exactly one concurrent dispatch executes; the other attaches",
      );
      assert(
        (await scopeCount(exc1.id)) === 1,
        "S1: concurrent duplicate dispatch must create exactly one investigation row",
      );
      assert(
        (await proposalCount(first.investigationId)) === 1,
        "S1: concurrent duplicate dispatch must produce exactly one proposal",
      );
    }

    // ---------- S2: resume of an abandoned RUNNING row (crash recovery) ----------
    {
      const orphan = await prisma.runAsSystem(() =>
        prisma.aiInvestigation.create({
          data: {
            tenantId: tenant.id,
            storeId: storeA.id,
            exceptionId: exc2.id,
            model: "crashed-worker",
            status: "RUNNING",
            executionClaimId: "crashed-claim",
            executionClaimedAt: new Date(Date.now() - 600_000),
          },
        }),
      );

      llm.setScript([escalateTurn(exc2.id)]);
      const result = await prisma.runAsTenant(tenant.id, () =>
        investigationService.investigate({
          tenantId: tenant.id,
          storeId: storeA.id,
          exceptionId: exc2.id,
        }),
      );

      assert(
        result.investigationId === orphan.id,
        "S2: the retry must RESUME the abandoned row, not create a duplicate",
      );
      assert(result.status === "COMPLETED", `S2: resume must complete: ${result.error}`);
      assert(
        (await scopeCount(exc2.id)) === 1,
        "S2: exactly one authoritative record after resume",
      );
      assert(
        (await proposalCount(orphan.id)) === 1,
        "S2: the recovered run produced exactly one proposal",
      );

      const row = await prisma.runAsSystem(() =>
        prisma.aiInvestigation.findUniqueOrThrow({ where: { id: orphan.id } }),
      );
      assert(row.status === "COMPLETED", "S2: resumed row is terminal COMPLETED");
      assert(
        row.executionClaimId !== "crashed-claim",
        "S2: the lease was taken over by the recovering run",
      );
    }

    // ---------- S3: bounded recovery sweep ----------
    {
      const stale = new Date(Date.now() - 600_000);

      const eligible = await prisma.runAsSystem(() =>
        prisma.aiInvestigation.create({
          data: {
            tenantId: tenant.id,
            storeId: storeA.id,
            exceptionId: exc3.id,
            model: "crashed",
            status: "RUNNING",
            executionClaimId: "gone-1",
            executionClaimedAt: stale,
          },
        }),
      );

      const capped = await prisma.runAsSystem(() =>
        prisma.aiInvestigation.create({
          data: {
            tenantId: tenant.id,
            storeId: storeA.id,
            exceptionId: exc4.id,
            model: "crashed",
            status: "RUNNING",
            executionClaimId: "gone-2",
            executionClaimedAt: stale,
          },
        }),
      );

      // Two prior recovery dispatches → at the cap.
      for (const _ of [1, 2]) {
        await prisma.runAsSystem(() =>
          auditService.recordEvent({
            tenantId: tenant.id,
            storeId: storeA.id,
            action: "AI_INVESTIGATION_RECOVERY_DISPATCHED",
            actorType: "AI_AGENT" as never,
            entityType: "AI_INVESTIGATION",
            entityId: capped.id,
            metadata: { prior: true },
          }),
        );
      }

      const overage = await prisma.runAsSystem(() =>
        prisma.aiInvestigation.create({
          data: {
            tenantId: tenant.id,
            storeId: storeA.id,
            exceptionId: exc5.id,
            model: "crashed",
            status: "RUNNING",
            executionClaimId: "gone-3",
            executionClaimedAt: stale,
            startedAt: new Date(Date.now() - 25 * 3_600_000),
          },
        }),
      );

      const sweep: AiRecoverySweepResult = await prisma.runAsSystem(() =>
        investigationService.recoverAbandonedInvestigations(),
      );

      const byId = new Map(
        sweep.actions.map((action) => [action.investigationId, action]),
      );

      assert(
        byId.get(eligible.id)?.action === "redispatch",
        "S3: eligible abandoned run is marked for redispatch",
      );
      assert(
        byId.get(capped.id)?.action === "abandoned",
        "S3: recovery-capped run is finalized as abandoned",
      );
      assert(
        byId.get(overage.id)?.action === "abandoned",
        "S3: over-age run is finalized as abandoned",
      );

      const cappedRow = await prisma.runAsSystem(() =>
        prisma.aiInvestigation.findUniqueOrThrow({ where: { id: capped.id } }),
      );
      const overageRow = await prisma.runAsSystem(() =>
        prisma.aiInvestigation.findUniqueOrThrow({ where: { id: overage.id } }),
      );
      assert(cappedRow.status === "FAILED", "S3: capped run terminal FAILED");
      assert(overageRow.status === "FAILED", "S3: over-age run terminal FAILED");

      const abandonedAudits = await prisma.runAsSystem(() =>
        prisma.auditEvent.count({
          where: {
            action: "AI_INVESTIGATION_ABANDONED",
            entityId: { in: [capped.id, overage.id] },
          },
        }),
      );
      assert(abandonedAudits === 2, "S3: abandonment is audited per run");

      // Recovery of the eligible run cannot duplicate proposals.
      llm.setScript([escalateTurn(exc3.id)]);
      const recovered = await prisma.runAsTenant(tenant.id, () =>
        investigationService.investigate({
          tenantId: tenant.id,
          storeId: storeA.id,
          exceptionId: exc3.id,
        }),
      );
      assert(
        recovered.investigationId === eligible.id,
        "S3: recovered dispatch resumes the same authoritative row",
      );
      assert(
        (await proposalCount(eligible.id)) === 1,
        "S3: recovered run cannot produce duplicate proposals",
      );
    }

    // ---------- S4: late provider response after cancellation ----------
    // The ControllableLlm parks any UNSCRIPTED call indefinitely (the
    // non-cancellable transport case): the run times out first, then the
    // provider answers — with a perfectly valid submit.
    {
      const result = await prisma.runAsTenant(tenant.id, () =>
        investigationService.investigate({
          tenantId: tenant.id,
          storeId: storeA.id,
          exceptionId: exc5.id,
        }),
      );

      assert(result.status === "FAILED", "S4: cancelled run reports FAILED");
      assert(
        /timed out/i.test(result.error ?? ""),
        `S4: failure reason is the timeout: ${result.error}`,
      );

      // The provider finally answers — a grounded, schema-valid submit.
      assert(llm.parkedCount === 1, "S4: exactly one in-flight provider call");
      llm.releaseNext(escalateTurn(exc5.id));
      await sleep(600);

      const row = await prisma.runAsSystem(() =>
        prisma.aiInvestigation.findUniqueOrThrow({
          where: { id: result.investigationId },
        }),
      );
      assert(row.status === "FAILED", "S4: late response cannot flip the outcome");
      assert(
        (await proposalCount(result.investigationId)) === 0,
        "S4: a late provider response must never publish a proposal",
      );
    }

    // ---------- S5: completed investigation + a genuinely new dispatch ----------
    {
      const s1Rows = await prisma.runAsSystem(() =>
        prisma.aiInvestigation.findMany({
          where: { tenantId: tenant.id, exceptionId: exc1.id },
          orderBy: { startedAt: "asc" },
        }),
      );
      assert(s1Rows.length === 1, "S5: precondition — one row from S1");
      const before = await proposalCount((s1Rows[0] as { id: string }).id);

      llm.setScript([escalateTurn(exc1.id)]);
      const rerun = await prisma.runAsTenant(tenant.id, () =>
        investigationService.investigate({
          tenantId: tenant.id,
          storeId: storeA.id,
          exceptionId: exc1.id,
        }),
      );

      assert(
        rerun.investigationId !== (s1Rows[0] as { id: string }).id,
        "S5: a new dispatch is a new investigation (sequential re-investigation stays possible)",
      );
      assert(
        (await proposalCount((s1Rows[0] as { id: string }).id)) === before,
        "S5: the completed investigation still has exactly its one proposal",
      );
      assert(
        (await proposalCount(rerun.investigationId)) === 1,
        "S5: the new run has its own single proposal",
      );
    }

    // ---------- S6: tenant/store scope separation ----------
    {
      const excA = exc1;
      const excB = exc6;

      const runs = await pumpUntilSettled(llm, [
        prisma.runAsTenant(tenant.id, () =>
          investigationService.investigate({
            tenantId: tenant.id,
            storeId: storeA.id,
            exceptionId: excA.id,
          }),
        ),
        prisma.runAsTenant(tenant.id, () =>
          investigationService.investigate({
            tenantId: tenant.id,
            storeId: storeB.id,
            exceptionId: excB.id,
          }),
        ),
      ]);

      await sleep(100);

      assert(
        runs.every((run) => run.status === "COMPLETED"),
        `S6: both scoped runs complete independently: ${JSON.stringify(
          runs.map((r) => r.error),
        )}`,
      );
      assert(
        runs[0]?.investigationId !== runs[1]?.investigationId,
        "S6: different stores are never coalesced into one investigation",
      );
    }

    // ---------- S7: retry exhaustion is durably recorded ----------
    {
      const throwingService = {
        investigate: async () => {
          throw new Error("database unreachable (simulated)");
        },
        recoverAbandonedInvestigations: async () => ({
          scanned: 0,
          actions: [],
        }),
      };

      const queueStub = { add: async () => ({}) };
      const worker = new AiInvestigationWorker(
        throwingService as never,
        prisma as never,
        auditService as never,
        queueStub as never,
      );

      const exhaustedJobId = `job-exhausted-${Date.now()}`;
      let processError: unknown = null;
      try {
        await worker.process({
          id: exhaustedJobId,
          name: AI_INVESTIGATION_JOB,
          data: {
            tenantId: tenant.id,
            storeId: storeA.id,
            exceptionId: exc1.id,
          },
          opts: { attempts: 5 },
          attemptsMade: 4,
        } as never);
      } catch (error) {
        processError = error;
      }

      assert(processError !== null, "S7: the final attempt still rethrows for BullMQ dead-lettering");
      assert(
        /database unreachable/.test(
          processError instanceof Error ? processError.message : String(processError),
        ),
        `S7: the rethrown error is the original infrastructure failure (got: ${
          processError instanceof Error ? processError.message : String(processError)
        })`,
      );

      const exhausted = await prisma.runAsSystem(() =>
        prisma.auditEvent.count({
          where: {
            action: "AI_INVESTIGATION_JOB_EXHAUSTED",
            entityId: exhaustedJobId,
          },
        }),
      );
      assert(exhausted === 1, "S7: exhaustion leaves a durable, queryable record");

      // Recovery sweep is idempotent and safe to run repeatedly.
      const sweep1 = await prisma.runAsSystem(() =>
        investigationService.recoverAbandonedInvestigations(),
      );
      const sweep2 = await prisma.runAsSystem(() =>
        investigationService.recoverAbandonedInvestigations(),
      );
      assert(
        sweep2.scanned === 0 || sweep2.actions.length <= sweep1.actions.length,
        "S7: the sweep is bounded and cannot loop uncontrolled",
      );
    }

    // ---------- RLS sanity: foreign-tenant reads see nothing ----------
    {
      const foreign = await prisma.runAsTenant(
        "00000000-0000-4000-8000-000000000001",
        () =>
          prisma.aiInvestigation.findMany({
            where: { exceptionId: exc1.id },
          }),
      );
      assert(
        foreign.length === 0,
        "RLS: cross-tenant investigation reads must be empty",
      );
    }

    console.log(
      JSON.stringify(
        {
          result: "PASS",
          rls: "ok",
          checks: {
            "S1 concurrent duplicate dispatch → 1 row / 1 proposal / 1 attached": "ok",
            "S2 resume of abandoned row reuses the record": "ok",
            "S3 bounded recovery sweep (redispatch / capped / over-age)": "ok",
            "S4 late provider response cannot publish": "ok",
            "S5 new dispatch is a new run; old proposal untouched": "ok",
            "S6 store scopes never coalesce": "ok",
            "S7 retry exhaustion durably recorded; sweep bounded": "ok",
          },
        },
        null,
        2,
      ),
    );
  } finally {
    await app.close();
  }
}

tenantContextStorage.run({ bypass: true }, () => main()).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

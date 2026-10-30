/**
 * ai-queue-redis-integration-test.ts — Phase 2B.1: queue reliability
 * verified against a REAL Redis instance and REAL BullMQ workers using the
 * repository's own producer (AiInvestigationQueueService) and consumer
 * (AiInvestigationWorker) implementations. No live LLM calls (LLM_CLIENT is
 * overridden with a deterministic double; tool calls still execute for real
 * against PostgreSQL).
 *
 * Scenarios:
 *   R1  successful job processing (producer → real worker → DB outcome)
 *   R2  retryable failure + measured exponential backoff (job opts verified
 *       against actual BullMQ timing)
 *   R3  permanent failure (persisted FAILED investigation) without retry
 *   R4  retry exhaustion → failed-job retention (visible to operators)
 *   R5  durable AI_INVESTIGATION_JOB_EXHAUSTED audit event
 *   R6  duplicate dispatch deduplication via deterministic jobId
 *   R7  worker termination mid-investigation (force-close, job abandoned)
 *   R8  worker restart + stalled-job recovery: resume on the same row, a
 *       late zombie response cannot publish, no duplicate proposal/autonomy
 *   R9  Redis interruption + reconnection (buffered producer add, live
 *       consumer resumes)
 *   R10 recovery-sweep × queue interaction (sweep job → redispatch job with
 *       bounded attempts:1 → resumed authoritative row)
 *
 * Provisioning: starts an ISOLATED redis-server (own port + dir, no
 * persistence) for this run only and kills it in cleanup. Binary lookup:
 * REDIS_SERVER_BIN, then `redis-server` on PATH, then the Phase 2B.1 build
 * (/tmp/redis-src/redis-7.2.5/src/redis-server).
 *
 * Run: npx ts-node ai-queue-redis-integration-test.ts
 */
import { spawn, spawnSync, ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import * as net from "node:net";

import { Test } from "@nestjs/testing";

// NOTE: AppModule is imported DYNAMICALLY (inside main, after the test
// environment variables are set). ConfigModule.forRoot() snapshots and
// validates the environment at module-load time, so static imports would
// freeze .env values before the overrides below apply.
import { PrismaService } from "./src/prisma/prisma.service";
import { tenantContextStorage } from "./src/prisma/tenant-context";
import { encryptSecret } from "./src/shopify/shopify-auth.crypto";
import { ExceptionService } from "./src/oms/exception/exception.service";
import { AiInvestigationService } from "./src/ai/investigation/ai-investigation.service";
import { AiInvestigationWorker } from "./src/ai/queue/ai-investigation.worker";
import {
  AI_INVESTIGATION_QUEUE,
  AI_RECOVERY_JOB,
  AiInvestigationQueueService,
} from "./src/ai/queue/ai-investigation.queue";
import {
  LLM_CLIENT,
  LlmChatCompletionInput,
  LlmChatCompletionResult,
  LlmClient,
} from "./src/ai/llm/llm-client.interface";
import type { Queue, Job } from "bullmq";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`TEST FAILED: ${message}`);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = await fn();

    if (value) {
      return value;
    }

    await sleep(100);
  }

  throw new Error(`TEST FAILED: timed out waiting for: ${label}`);
}

// ============================================================
// Isolated Redis provisioning
// ============================================================

const REDIS_PORT = Number(process.env.REDIS_IT_PORT ?? 6391);
const REDIS_DIR = `/tmp/redis-aiq-it-${process.pid}`;

function findRedisBin(): string {
  const candidates = [
    process.env.REDIS_SERVER_BIN,
    "/tmp/redis-src/redis-7.2.5/src/redis-server",
  ];

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }

  const which = spawnSync("which", ["redis-server"], { encoding: "utf8" });

  if (which.status === 0 && which.stdout.trim()) {
    return which.stdout.trim();
  }

  throw new Error(
    "redis-server binary not found. Set REDIS_SERVER_BIN or install Redis (Phase 2B.1 built 7.2.5 from source).",
  );
}

function startRedis(): ChildProcess {
  mkdirSync(REDIS_DIR, { recursive: true });

  const child = spawn(
    findRedisBin(),
    [
      "--port",
      String(REDIS_PORT),
      "--bind",
      "127.0.0.1",
      "--dir",
      REDIS_DIR,
      "--save",
      "",
      "--appendonly",
      "no",
    ],
    { stdio: "ignore" },
  );

  return child;
}

/** Test isolation: refuse to run against a stale instance on our port. */
async function assertPortFree(): Promise<void> {
  const busy = await new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: REDIS_PORT });

    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });

  if (busy) {
    throw new Error(
      `TEST FAILED: port ${REDIS_PORT} is already occupied (stale redis instance?) — refusing to run against non-isolated state`,
    );
  }
}

async function waitRedisReady(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port: REDIS_PORT });

      socket.once("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
    });

    if (ok) {
      return;
    }

    await sleep(100);
  }

  throw new Error("TEST FAILED: isolated redis-server did not become ready");
}

// ============================================================
// Controllable LLM double (same contract as the reliability suite)
// ============================================================

type ScriptedTurn = {
  content?: string;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
  throwMessage?: string;
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

  get parkedCount(): number {
    return this.parked.length;
  }

  async createChatCompletion(
    input: LlmChatCompletionInput,
  ): Promise<LlmChatCompletionResult> {
    const scripted = this.scriptQueue.shift();

    if (scripted?.throwMessage) {
      throw new Error(scripted.throwMessage);
    }

    if (scripted) {
      return turnToResult(scripted);
    }

    if (input.signal?.aborted) {
      throw new Error("Provider call cancelled before dispatch");
    }

    return new Promise((resolve) => {
      this.parked.push({ resolve, input });
    });
  }
}

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

// ============================================================
// Scenarios
// ============================================================

async function main(): Promise<void> {
  process.env.AI_INVESTIGATION_TIMEOUT_MS = "3000";
  process.env.AI_INVESTIGATION_JOB_ATTEMPTS = "3";
  process.env.AI_INVESTIGATION_JOB_BACKOFF_MS = "200";
  process.env.AI_INVESTIGATION_JOB_REMOVE_ON_FAIL = "500";
  // Manual sweep only — deterministic scheduling in this suite.
  process.env.AI_RECOVERY_SWEEP_INTERVAL_MS = "0";
  process.env.REDIS_URL = `redis://127.0.0.1:${REDIS_PORT}`;

  let redis: ChildProcess | null;
  await assertPortFree();
  redis = startRedis();
  await waitRedisReady();

  const redisVersion = spawnSync(findRedisBin(), ["--version"], {
    encoding: "utf8",
  }).stdout.trim();

  const llm = new ControllableLlm();

  // Load the application ONLY after the environment overrides above are
  // in place (ConfigModule snapshots env at import/forRoot time).
  const { AppModule } = await import("./src/app.module");

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(LLM_CLIENT)
    .useValue(llm)
    .compile();

  const app = moduleRef;
  // Run module lifecycle hooks — BullExplorer registers the REAL BullMQ
  // worker only in onModuleInit/onApplicationBootstrap.
  await app.init();

  const prisma = app.get(PrismaService, { strict: false });
  const exceptionService = app.get(ExceptionService, { strict: false });
  const investigationService = app.get(AiInvestigationService, {
    strict: false,
  });
  const queueService = app.get(AiInvestigationQueueService, { strict: false });
  const queue: Queue = app.get(
    (await import("@nestjs/bullmq")).getQueueToken(AI_INVESTIGATION_QUEUE),
    { strict: false },
  );
  const nestWorker = app.get(AiInvestigationWorker, { strict: false });

  const {
    Worker,
  }: typeof import("bullmq") = await import("bullmq");
  const {
    parseRedisConnectionOptions,
  }: typeof import("./src/config/redis-connection") = await import(
    "./src/config/redis-connection"
  );
  const connection = parseRedisConnectionOptions(
    `redis://127.0.0.1:${REDIS_PORT}`,
  );

  try {
    // ---------------- seed ----------------
    const tenant = await prisma.runAsSystem(() =>
      prisma.tenant.create({ data: { name: `redisit-${Date.now()}` } }),
    );

    const store = await prisma.runAsSystem(() =>
      prisma.storeConnection.create({
        data: {
          tenantId: tenant.id,
          externalStoreId: `redisit-${Date.now()}.myshopify.com`,
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

    const makeException = (label: string) =>
      prisma.runAsTenant(tenant.id, () =>
        exceptionService.createOrUpdateException({
          tenantId: tenant.id,
          storeId: store.id,
          fingerprint: `redisit-${label}-${Date.now()}`,
          // Non-eligible category: the SEED must not auto-enqueue its own
          // dispatch — each scenario drives exactly one explicit dispatch
          // through the real queue. (Category eligibility gating is covered
          // by exception.service.spec; this suite tests broker semantics.)
          category: "QUEUE_IT_MANUAL_DISPATCH",
          severity: "HIGH" as never,
          title: `RedisIT ${label}`,
          evidence: { sku: "sku-managed-1" },
          recommendedNextStep: "investigate",
        }),
      );

    const scopeRows = async (exceptionId: string) =>
      prisma.runAsSystem(() =>
        prisma.aiInvestigation.findMany({ where: { exceptionId } }),
      );
    const proposalCount = async (investigationId: string) =>
      prisma.runAsSystem(() =>
        prisma.aiDecisionProposal.count({ where: { investigationId } }),
      );

    const trackAutonomy = () => {
      const autonomy = (investigationService as unknown as {
        aiAutonomyService: {
          maybeAutoExecute: (...args: unknown[]) => Promise<unknown>;
        };
      }).aiAutonomyService;
      const original = autonomy.maybeAutoExecute.bind(autonomy);
      const calls: string[] = [];
      autonomy.maybeAutoExecute = async (...args: unknown[]) => {
        calls.push(String((args[0] as { proposalId?: string })?.proposalId));

        return original(...args);
      };

      return calls;
    };

    // ---------------- R1: successful processing ----------------
    {
      const exc = await makeException("R1");
      const dispatchKey = `r1:${Date.now()}`;
      llm.setScript([escalateTurn(exc.id)]);

      await prisma.runAsTenant(tenant.id, () =>
        queueService.enqueue({
          tenantId: tenant.id,
          storeId: store.id,
          exceptionId: exc.id,
          dispatchKey,
        }),
      );

      const job = await waitFor("R1 job completed", async () => {
        const entry = await queue.getJob(`investigate:${dispatchKey}`);

        return (await entry?.getState()) === "completed" ? entry : null;
      });

      const rows = await waitFor("R1 COMPLETED row", async () => {
        const list = await scopeRows(exc.id);

        return list.length === 1 && list[0]?.status === "COMPLETED"
          ? list
          : null;
      });

      assert(await proposalCount(rows[0]?.id ?? "") === 1, "R1: one proposal");
      assert(
        (await prisma.runAsSystem(() =>
          prisma.auditEvent.count({
            where: {
              action: "AI_INVESTIGATION_COMPLETED",
              entityId: exc.id,
              metadata: {
                path: ["investigationId"],
                equals: rows[0]?.id,
              },
            },
          }),
        )) === 1,
        "R1: completion audited",
      );
      assert(
        (job as Job).attemptsMade === 1,
        "R1: exactly one processing attempt (BullMQ counts attempts in attemptsMade, including successful ones)",
      );
    }

    // ---------------- R2: retryable failure + exponential backoff ----------------
    {
      const exc = await makeException("R2");
      const dispatchKey = `r2:${Date.now()}`;
      const service = investigationService as unknown as {
        investigate: (input: {
          tenantId: string;
          storeId: string;
          exceptionId: string;
        }) => Promise<unknown>;
      };
      const original = service.investigate.bind(investigationService);
      const attemptTimes: number[] = [];
      let failures = 0;

      service.investigate = (input) => {
        if (input.exceptionId === exc.id) {
          attemptTimes.push(Date.now());
        }

        if (input.exceptionId === exc.id && failures < 2) {
          failures += 1;
          throw new Error("simulated infrastructure failure");
        }

        return original(input) as Promise<unknown>;
      };

      llm.setScript([escalateTurn(exc.id)]);
      await queueService.enqueue({
        tenantId: tenant.id,
        storeId: store.id,
        exceptionId: exc.id,
        dispatchKey,
      });

      const job = await waitFor("R2 job completed after retries", async () => {
        const entry = await queue.getJob(`investigate:${dispatchKey}`);

        return (await entry?.getState()) === "completed" ? entry : null;
      });

      service.investigate = original as typeof service.investigate;

      assert(failures === 2, "R2: exactly two injected failures");
      assert(
        (job as Job).attemptsMade === 3,
        "R2: three processing attempts (2 failed + 1 success — BullMQ counts attempts, not failures)",
      );
      assert(
        (job as Job).attemptsStarted === 3,
        "R2: three attempts were started",
      );

      const gap1 = (attemptTimes[1] ?? 0) - (attemptTimes[0] ?? 0);
      const gap2 = (attemptTimes[2] ?? 0) - (attemptTimes[1] ?? 0);
      // Exponential backoff (200ms base): first retry ≈ 200ms, second ≈ 400ms.
      // Measured against ACTUAL BullMQ scheduling with a tolerance.
      assert(gap1 >= 150, `R2: first backoff ≥ ~200ms (got ${gap1}ms)`);
      assert(gap2 >= 350, `R2: second backoff ≥ ~400ms — exponential (got ${gap2}ms)`);
      assert(
        gap2 > gap1,
        `R2: backoff grew between attempts (${gap1}ms → ${gap2}ms)`,
      );

      // Requirement 4: job options as BullMQ actually stored them.
      const opts = (job as Job).opts;
      assert(opts.attempts === 3, "R2: opts.attempts recorded as 3");
      assert(
        (opts.backoff as { type?: string })?.type === "exponential" &&
          (opts.backoff as { delay?: number })?.delay === 200,
        `R2: opts.backoff is exponential/200 (got ${JSON.stringify(opts.backoff)})`,
      );

      const rows = await scopeRows(exc.id);
      assert(rows.length === 1, "R2: retries resume ONE authoritative row");
      assert(rows[0]?.status === "COMPLETED", "R2: eventual success");
    }

    // ---------------- R3: permanent failure without retry ----------------
    {
      const exc = await makeException("R3");
      const dispatchKey = `r3:${Date.now()}`;
      llm.setScript([{ toolCalls: [], throwMessage: "provider transport exploded" }]);

      await queueService.enqueue({
        tenantId: tenant.id,
        storeId: store.id,
        exceptionId: exc.id,
        dispatchKey,
      });

      const job = await waitFor("R3 job reached a terminal state", async () => {
        const entry = await queue.getJob(`investigate:${dispatchKey}`);
        const state = await entry?.getState();

        return state === "completed" || state === "failed" ? entry : null;
      });

      // A persisted FAILED investigation is a PERMANENT outcome: the job
      // completes and is never retried.
      assert(
        (await (job as Job).getState()) === "completed",
        "R3: business failure completes the job (no retry)",
      );
      assert(
        (job as Job).attemptsMade === 1,
        "R3: exactly one attempt — no unnecessary retry",
      );

      const rows = await scopeRows(exc.id);
      assert(rows.length === 1 && rows[0]?.status === "FAILED", "R3: one FAILED row");
      assert(
        /provider transport exploded/.test(rows[0]?.error ?? ""),
        "R3: classified provider failure persisted",
      );
    }

    // ---------------- R4 + R5: exhaustion, retention, durable audit ----------------
    {
      const exc = await makeException("R4");
      const dispatchKey = `r4:${Date.now()}`;
      const service = investigationService as unknown as {
        investigate: () => Promise<unknown>;
      };
      const original = service.investigate.bind(investigationService);
      service.investigate = () =>
        Promise.reject(new Error("database unreachable (simulated)"));

      await queueService.enqueue({
        tenantId: tenant.id,
        storeId: store.id,
        exceptionId: exc.id,
        dispatchKey,
      });

      const job = await waitFor("R4 job failed after exhaustion", async () => {
        const entry = await queue.getJob(`investigate:${dispatchKey}`);

        return (await entry?.getState()) === "failed" ? entry : null;
      });

      service.investigate = original as typeof service.investigate;

      assert(
        (job as Job).attemptsMade === 3,
        `R4: exhausted exactly opts.attempts attempts (got ${(job as Job).attemptsMade})`,
      );

      // Failed-job retention: the exhausted job is still queryable.
      const failed = await queue.getFailed(0, 10);
      assert(
        failed.some((entry) => entry.id === (job as Job).id),
        "R4: exhausted job retained in the failed set (not silently discarded)",
      );

      // Durable exhaustion audit (R5).
      await waitFor("R5 exhaustion audit row", async () =>
        prisma.runAsSystem(() =>
          prisma.auditEvent.findFirst({
            where: {
              action: "AI_INVESTIGATION_JOB_EXHAUSTED",
              entityId: `investigate:${dispatchKey}`,
            },
          }),
        ),
      );

      const auditRow = await prisma.runAsSystem(() =>
        prisma.auditEvent.findFirstOrThrow({
          where: {
            action: "AI_INVESTIGATION_JOB_EXHAUSTED",
            entityId: `investigate:${dispatchKey}`,
          },
        }),
      );
      assert(
        (auditRow.metadata as { attempts?: number })?.attempts === 3,
        "R5: audit records the exhausted attempt count",
      );
    }

    // ---------------- R6: duplicate dispatch + deterministic jobId ----------------
    {
      const exc = await makeException("R6");
      const dispatchKey = `r6:${Date.now()}`;
      llm.setScript([escalateTurn(exc.id)]);

      await queueService.enqueue({
        tenantId: tenant.id,
        storeId: store.id,
        exceptionId: exc.id,
        dispatchKey,
      });
      await queueService.enqueue({
        tenantId: tenant.id,
        storeId: store.id,
        exceptionId: exc.id,
        dispatchKey,
      });

      const job = await waitFor("R6 job completed", async () => {
        const entry = await queue.getJob(`investigate:${dispatchKey}`);

        return (await entry?.getState()) === "completed" ? entry : null;
      });

      assert(
        (job as Job).id === `investigate:${dispatchKey}`,
        "R6: deterministic job id",
      );
      assert(
        (job as Job).attemptsMade === 1 && (job as Job).attemptsStarted === 1,
        "R6: the duplicate enqueue never started a second execution (one attempt)",
      );

      const rows = await scopeRows(exc.id);
      assert(rows.length === 1, "R6: one authoritative investigation row");
      assert(await proposalCount(rows[0]?.id ?? "") === 1, "R6: one proposal");
    }

    // ---------------- R9: Redis interruption + reconnection ----------------
    {
      const exc = await makeException("R9");
      const dispatchKey = `r9:${Date.now()}`;
      llm.setScript([escalateTurn(exc.id)]);

      // Take the isolated instance down.
      const down = new Promise<void>((resolve) => {
        (redis as ChildProcess).once("exit", () => resolve());
      });
      (redis as ChildProcess).kill("SIGTERM");
      await down;

      // Producer add during the outage is buffered by ioredis
      // (maxRetriesPerRequest: null — the repository's connection contract)
      // and flushes on reconnect. Do not await yet.
      const pending = queueService.enqueue({
        tenantId: tenant.id,
        storeId: store.id,
        exceptionId: exc.id,
        dispatchKey,
      });

      await sleep(400);
      assert(
        (await scopeRows(exc.id)).length === 0,
        "R9: nothing processes while the broker is down",
      );

      // Bring the same instance back (same port/dir — clients reconnect).
      redis = startRedis();
      await waitRedisReady();
      await pending;

      // The SAME consumer (Nest worker, never restarted) must pick it up.
      await waitFor("R9 job completed after reconnection", async () => {
        const entry = await queue.getJob(`investigate:${dispatchKey}`);

        return (await entry?.getState()) === "completed" ? entry : null;
      });

      const rows = await scopeRows(exc.id);
      assert(rows.length === 1, "R9: exactly one row across the outage");
      assert(rows[0]?.status === "COMPLETED", "R9: processed after reconnect");
    }

    // ---------------- R10: recovery sweep × queue retries ----------------
    {
      const exc = await makeException("R10");

      // Orphaned run (crashed worker): RUNNING with an expired lease.
      const orphan = await prisma.runAsSystem(() =>
        prisma.aiInvestigation.create({
          data: {
            tenantId: tenant.id,
            storeId: store.id,
            exceptionId: exc.id,
            model: "crashed",
            status: "RUNNING",
            executionClaimId: "gone",
            executionClaimedAt: new Date(Date.now() - 600_000),
          },
        }),
      );

      llm.setScript([escalateTurn(exc.id)]);

      // Drive the sweep through the REAL queue (the job name the repeatable
      // scheduler uses; disabled here for determinism).
      await queue.add(AI_RECOVERY_JOB, {}, { jobId: `sweep-${Date.now()}` });

      // The sweep job redispatches an investigation job (bounded attempts:1)
      // which RESUMES the orphan row.
      let rows: Array<{ id: string; status: string; error?: string | null }>;
      try {
        rows = await waitFor("R10 recovered run completed", async () => {
          const list = await scopeRows(exc.id);

          return list.length === 1 && list[0]?.status === "COMPLETED"
            ? list
            : null;
        });
      } catch (error) {
        const list = await scopeRows(exc.id);
        const jobs = await queue.getJobs([
          "completed",
          "failed",
          "waiting",
          "active",
          "delayed",
        ]);
        console.log(
          "[DIAG] R10 rows:",
          JSON.stringify(list),
          "jobs:",
          jobs
            .map((entry) => `${entry.name}:${entry.id}:${entry.opts.attempts}`)
            .join(" | "),
        );
        throw error;
      }

      assert(
        rows[0]?.id === orphan.id,
        "R10: recovery resumes the SAME authoritative row",
      );
      assert(
        (await proposalCount(orphan.id)) === 1,
        "R10: recovery cannot duplicate proposals",
      );
      assert(
        (await prisma.runAsSystem(() =>
          prisma.auditEvent.count({
            where: {
              action: "AI_INVESTIGATION_RECOVERY_DISPATCHED",
              entityId: orphan.id,
            },
          }),
        )) === 1,
        "R10: recovery dispatch audited",
      );

      // The redispatch job itself is bounded (attempts: 1 — no retry loop)
      // and carries the deterministic recovery job id.
      const allJobs = await queue.getJobs([
        "completed",
        "failed",
        "waiting",
        "active",
        "delayed",
      ]);
      const redispatch = allJobs.find(
        (entry) =>
          typeof entry.id === "string" &&
          entry.id.startsWith("investigate:recovery:") &&
          entry.id.includes(orphan.id),
      );
      assert(
        redispatch !== undefined,
        `R10: recovery redispatch job exists (ids: ${allJobs
          .map((entry) => entry.id)
          .join(" | ")})`,
      );
      assert(
        (redispatch as Job).opts.attempts === 1,
        "R10: sweep redispatches are one-shot (bounded recovery)",
      );
    }

    // ---------------- R7 + R8: termination, stalled recovery, zombie ----------------
    {
      const exc = await makeException("R7R8");

      // Replace the Nest consumer with a fast-lock real BullMQ worker that
      // runs the repository's worker logic (same process() method).
      await nestWorker.worker.close(true);
      const makeWorker = () =>
        new Worker(
          AI_INVESTIGATION_QUEUE,
          (job: Job) =>
            (
              nestWorker as unknown as {
                process: (job: Job) => Promise<unknown>;
              }
            ).process(job),
          {
            connection,
            lockDuration: 1500,
            stalledInterval: 300,
            maxStalledCount: 10,
          },
        );

      const workerA = makeWorker();
      const autonomyCalls = trackAutonomy();

      // R7: the investigation starts and parks on the provider call.
      await queueService.enqueue({
        tenantId: tenant.id,
        storeId: store.id,
        exceptionId: exc.id,
        dispatchKey: `r7:${Date.now()}`,
      });

      await waitFor("R7 run in flight (parked on provider)", async () =>
        llm.parkedCount === 1 ? true : null,
      );

      const rowsInFlight = await scopeRows(exc.id);
      assert(
        rowsInFlight.length === 1 && rowsInFlight[0]?.status === "RUNNING",
        "R7: authoritative row exists and is RUNNING",
      );
      const originalRowId = rowsInFlight[0]?.id ?? "";

      // Terminate the consumer mid-investigation (force-close abandons the
      // active job; the parked provider call is the zombie).
      await workerA.close(true);

      // R8: a restarted consumer recovers the stalled job.
      const workerB = makeWorker();

      // The recovered (redelivered) run resumes the row and parks on its
      // own provider call — releasing turns now, zombie first.
      await waitFor("R8 recovered run in flight", async () =>
        llm.parkedCount >= 2 ? true : null,
      );

      // The ZOMBIE's provider call returns first — with a valid submit.
      llm.releaseNext(escalateTurn(exc.id));
      await sleep(700);

      assert(
        (await proposalCount(originalRowId)) === 0,
        "R8: a late zombie response cannot publish a proposal",
      );
      assert(
        (await scopeRows(exc.id))[0]?.status === "RUNNING",
        "R8: the zombie cannot flip the outcome the survivor owns",
      );

      // Now the surviving run's provider call returns.
      llm.releaseNext(escalateTurn(exc.id));

      const rows = await waitFor(
        "R8 stalled job recovered on the same row",
        async () => {
          const list = await scopeRows(exc.id);

          return list.length === 1 && list[0]?.status === "COMPLETED"
            ? list
            : null;
        },
        20_000,
      );

      assert(
        rows[0]?.id === originalRowId,
        "R8: stall recovery RESUMES the same authoritative row (no duplicate)",
      );
      assert(
        (await proposalCount(originalRowId)) === 1,
        "R8: exactly one proposal after recovery",
      );
      assert(autonomyCalls.length === 1, "R8: autonomy hook ran exactly once");

      await sleep(300);

      assert(
        (await proposalCount(originalRowId)) === 1,
        "R8: no duplicate proposal after the zombie's late return",
      );
      assert(
        (await scopeRows(exc.id))[0]?.status === "COMPLETED",
        "R8: terminal outcome held",
      );
      assert(autonomyCalls.length === 1, "R8: no duplicate autonomy execution");

      await workerB.close();
    }

    // ---------------- RLS sanity (PG invariants intact) ----------------
    {
      const foreign = await prisma.runAsTenant(
        "00000000-0000-4000-8000-000000000001",
        () => prisma.aiInvestigation.findMany(),
      );
      assert(foreign.length === 0, "RLS: cross-tenant reads remain empty");
    }

    const require2 = createRequire(__filename);
    const bullmqVersion = (
      require2("bullmq/package.json") as { version: string }
    ).version;
    const ioredisVersion = (
      require2("ioredis/package.json") as { version: string }
    ).version;

    console.log(
      JSON.stringify(
        {
          result: "PASS",
          rls: "ok",
          versions: {
            redis: redisVersion,
            bullmq: bullmqVersion,
            ioredis: ioredisVersion,
          },
          checks: {
            "R1 successful job processing": "ok",
            "R2 retryable failure + exponential backoff (measured)": "ok",
            "R3 permanent failure without unnecessary retry": "ok",
            "R4 retry exhaustion + failed-job retention": "ok",
            "R5 durable exhaustion audit event": "ok",
            "R6 duplicate dispatch deduplicated by deterministic jobId": "ok",
            "R7 worker termination mid-investigation": "ok",
            "R8 stall recovery + zombie non-publication + no duplicate autonomy": "ok",
            "R9 Redis interruption + reconnection (producer+consumer)": "ok",
            "R10 recovery sweep x queue retries (bounded redispatch)": "ok",
          },
        },
        null,
        2,
      ),
    );
  } finally {
    await Promise.race([
      app.close().catch(() => undefined),
      sleep(5_000),
    ]);

    if (redis && !redis.killed) {
      redis.kill("SIGTERM");
    }

    rmSync(REDIS_DIR, { recursive: true, force: true });
  }
}

tenantContextStorage
  .run({ bypass: true }, () => main())
  .then(() => {
    // Exit only AFTER main() resolves (its finally has torn down the
    // isolated Redis and the app) — an in-try process.exit() would skip
    // cleanup and poison repeat runs. The explicit exit also releases
    // lingering broker client handles owned by the custom test workers.
    process.exit(0);
  })
  .catch((error) => {
    console.error(
      error instanceof Error ? error.stack ?? error.message : error,
    );
    // Never linger on teardown quirks — the verdict is already decided.
    process.exit(1);
  });

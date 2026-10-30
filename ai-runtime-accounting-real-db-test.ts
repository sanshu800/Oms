/**
 * ai-runtime-accounting-real-db-test.ts — Phase 2C acceptance against
 * REAL PostgreSQL (the atomicity/isolation arbiter) + REAL RLS:
 * token-budget reservation/settlement, concurrent double-spend prevention,
 * idempotent and interrupted settlement, tenant isolation, usage/cost
 * accounting, and stable failure-code persistence. No live provider calls
 * (no LLM involvement at all — this suite drives the real accounting
 * services directly).
 *
 * Scenarios:
 *   A1  concurrent reservation exclusivity — N racing reservations under a
 *       limit that fits exactly ONE: exactly one wins, the rest get
 *       BudgetExceededError (atomic conditional increment in real SQL)
 *   A2  concurrent investigation lifecycles cannot double-spend — two
 *       full reserve->settle sequences over one limit: exactly one succeeds,
 *       accounted consumption never exceeds the limit
 *   A3  settlement idempotency — settle twice, counters move once
 *   A4  unknown usage — conservative reservation kept + uncertain flag,
 *       never an incorrect refund
 *   A5  pre-dispatch release — full refund, idempotent
 *   A6  interrupted settlement recovery (settleAbandoned) — conservative,
 *       uncertain, idempotent
 *   A7  daily/monthly exhaustion + period rollover — correct limit kinds,
 *       a fresh period key reopens the budget
 *   A8  tenant isolation — one tenant's consumption never touches another's
 *       budget, and RLS hides foreign ledger rows
 *   A9  retries cannot bypass an exhausted budget
 *   A10 per-investigation usage summary accumulates across attempts
 *   A11 usage rows: REPORTED vs ESTIMATED vs UNKNOWN provenance, unknown
 *       pricing represented explicitly (never zero), versioned cost
 *   A12 operator tenant budget override (AiTenantBudgetLimit) is honored
 *   A13 guarded failureCode persistence on the investigation row
 *
 * Run: npx ts-node ai-runtime-accounting-real-db-test.ts
 */
import { Test } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bullmq";

import { AppModule } from "./src/app.module";
import { PrismaService } from "./src/prisma/prisma.service";
import { encryptSecret } from "./src/shopify/shopify-auth.crypto";
import { ExceptionService } from "./src/oms/exception/exception.service";
import {
  AiBudgetService,
  BudgetExceededError,
} from "./src/ai/accounting/ai-budget.service";
import { AiUsageService } from "./src/ai/accounting/ai-usage.service";
import { ModelPricingService } from "./src/ai/accounting/model-pricing.service";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`TEST FAILED: ${message}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SCENARIO_RESULTS: Array<{ scenario: string; ok: boolean; detail: string }> =
  [];

async function scenario(
  name: string,
  fn: () => Promise<string>,
): Promise<void> {
  try {
    const detail = await fn();
    SCENARIO_RESULTS.push({ scenario: name, ok: true, detail });
    console.log(`[PASS] ${name} — ${detail}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    SCENARIO_RESULTS.push({ scenario: name, ok: false, detail });
    console.log(`[FAIL] ${name} — ${detail}`);
    throw error;
  }
}

async function main(): Promise<void> {
  console.log("[BOOT] compiling module …");
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    // Broker handle replaced with an in-memory stub: this suite verifies
    // DATABASE semantics only, and a real Queue.close() blocks forever on
    // the reconnect loop without a broker (same convention as the 2B
    // reliability suite).
  })
    .overrideProvider(getQueueToken("ai-investigation"))
    .useValue({
      add: async () => ({}),
      on: () => undefined,
      close: async () => undefined,
    })
    .compile();
  console.log("[BOOT] module compiled");

  const prisma = moduleRef.get(PrismaService, { strict: false });
  const exceptionService = moduleRef.get(ExceptionService, { strict: false });
  const budget = new AiBudgetService(prisma);
  const pricing = new ModelPricingService();
  const usage = new AiUsageService(prisma, pricing);

  console.log(`[BOOT] pricing config version: ${pricing.pricingVersion} (${pricing.currency})`);

  const limits = { dailyTokenLimit: 4_000, monthlyTokenLimit: 4_000 };
  const day = (offsetDays = 0) =>
    new Date(Date.now() + offsetDays * 86_400_000);

  try {
    // ---------- seed: two tenants, one store each ---------- //
    const tenantA = await prisma.runAsSystem(() =>
      prisma.tenant.create({ data: { name: `acct-a-${Date.now()}` } }),
    );
    const tenantB = await prisma.runAsSystem(() =>
      prisma.tenant.create({ data: { name: `acct-b-${Date.now()}` } }),
    );

    const makeStore = async (tenant: { id: string }, label: string) =>
      prisma.runAsSystem(() =>
        prisma.storeConnection.create({
          data: {
            tenantId: tenant.id,
            externalStoreId: `${label}-${Date.now()}.myshopify.com`,
            platform: "SHOPIFY",
            status: "ACTIVE",
            encryptedAccessToken: encryptSecret(
              "fake-token",
              "accounting-test-encryption-secret-32ch",
            ),
            scopes: ["read_orders"],
          },
        }),
      );

    const storeA = await makeStore(tenantA, "acct-a");
    const storeB = await makeStore(tenantB, "acct-b");

    const inputA = (investigationId: string, tokens = 4_000) => ({
      tenantId: tenantA.id,
      storeId: storeA.id,
      investigationId,
      tokens,
    });

    // ---------- A1: concurrent reservation exclusivity ---------- //
    await scenario("A1 concurrent reservation exclusivity", async () => {
      const attempts = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) =>
          prisma.runAsTenant(tenantA.id, () =>
            budget.reserve(inputA(`inv-a1-${i}`), limits),
          ),
        ),
      );

      const wins = attempts.filter((a) => a.status === "fulfilled");
      const losses = attempts.filter(
        (a): a is PromiseRejectedResult => a.status === "rejected",
      );

      assert(wins.length === 1, `expected exactly 1 winner, got ${wins.length}`);
      assert(losses.length === 7, `expected 7 losers, got ${losses.length}`);
      for (const loss of losses) {
        assert(
          loss.reason instanceof BudgetExceededError,
          `loser must fail with BudgetExceededError, got ${String(loss.reason)}`,
        );
      }

      const counter = await prisma.runAsTenant(tenantA.id, () =>
        prisma.aiBudgetCounter.findFirst({
          where: { tenantId: tenantA.id, periodKind: "DAY" },
        }),
      );
      assert(
        counter?.reservedTokens === 4_000,
        `counter must hold exactly the winner's reservation, got ${counter?.reservedTokens}`,
      );

      // cleanup for later scenarios
      await prisma.runAsSystem(() =>
        prisma.aiBudgetCounter.deleteMany({ where: { tenantId: tenantA.id } }),
      );
      await prisma.runAsSystem(() =>
        prisma.aiBudgetLedger.deleteMany({ where: { tenantId: tenantA.id } }),
      );

      return "8 racing reservations -> 1 fulfilled, 7 BudgetExceededError, counter == 4000";
    });

    // ---------- A2: concurrent lifecycles cannot double-spend ---------- //
    await scenario("A2 concurrent lifecycles cannot double-spend", async () => {
      const lifecycle = async (investigationId: string) =>
        prisma.runAsTenant(tenantA.id, async () => {
          const entry = await budget.reserve(inputA(investigationId), limits);
          await budget.settle({
            entryId: entry.id,
            actualTokens: 3_000,
            usageSource: "REPORTED",
          });
          return entry.id;
        });

      const attempts = await Promise.allSettled([
        lifecycle("inv-a2-left"),
        lifecycle("inv-a2-right"),
      ]);

      const wins = attempts.filter((a) => a.status === "fulfilled");
      assert(wins.length === 1, `expected exactly 1 lifecycle winner, got ${wins.length}`);

      const rows = await prisma.runAsTenant(tenantA.id, () =>
        prisma.aiBudgetCounter.findMany({
          where: { tenantId: tenantA.id },
        }),
      );
      for (const row of rows) {
        assert(
          row.reservedTokens <= 4_000,
          `counter ${row.periodKind} exceeded the limit: ${row.reservedTokens}`,
        );
        assert(row.reservedTokens >= 0, "counters must never go negative");
      }
      assert(
        rows.every((r) => r.reservedTokens === 3_000),
        `accounted consumption must equal the winner's actual (3000), got ${rows.map((r) => r.reservedTokens).join(",")}`,
      );

      await prisma.runAsSystem(() =>
        prisma.aiBudgetCounter.deleteMany({ where: { tenantId: tenantA.id } }),
      );
      await prisma.runAsSystem(() =>
        prisma.aiBudgetLedger.deleteMany({ where: { tenantId: tenantA.id } }),
      );

      return "2 concurrent reserve->settle lifecycles -> exactly 1 winner, counters == 3000 (no double-spend)";
    });

    // ---------- A3: settlement idempotency ---------- //
    await scenario("A3 settlement idempotency", async () => {
      const entry = await prisma.runAsTenant(tenantA.id, () =>
        budget.reserve(inputA("inv-a3"), limits),
      );
      await prisma.runAsTenant(tenantA.id, () =>
        budget.settle({
          entryId: entry.id,
          actualTokens: 1_000,
          usageSource: "REPORTED",
        }),
      );
      await prisma.runAsTenant(tenantA.id, () =>
        budget.settle({
          entryId: entry.id,
          actualTokens: 1_000,
          usageSource: "REPORTED",
        }),
      );

      const rows = await prisma.runAsTenant(tenantA.id, () =>
        prisma.aiBudgetCounter.findMany({ where: { tenantId: tenantA.id } }),
      );
      assert(
        rows.every((r) => r.reservedTokens === 1_000),
        `double settle must move counters once (1000), got ${rows.map((r) => r.reservedTokens).join(",")}`,
      );

      await prisma.runAsSystem(() =>
        prisma.aiBudgetCounter.deleteMany({ where: { tenantId: tenantA.id } }),
      );
      await prisma.runAsSystem(() =>
        prisma.aiBudgetLedger.deleteMany({ where: { tenantId: tenantA.id } }),
      );

      return "settled twice -> counters moved once (1000)";
    });

    // ---------- A4: unknown usage is conservative ---------- //
    await scenario("A4 unknown usage is conservative", async () => {
      const entry = await prisma.runAsTenant(tenantA.id, () =>
        budget.reserve(inputA("inv-a4"), limits),
      );
      await prisma.runAsTenant(tenantA.id, () =>
        budget.settle({
          entryId: entry.id,
          actualTokens: null,
          usageSource: "UNKNOWN",
          usageDisposition: "unknown",
        }),
      );

      const row = await prisma.runAsTenant(tenantA.id, () =>
        prisma.aiBudgetLedger.findUnique({ where: { id: entry.id } }),
      );
      assert(row?.status === "SETTLED", `status must be SETTLED, got ${row?.status}`);
      assert(row?.uncertain === true, "unknown usage must be marked uncertain");
      assert(row?.actualTokens === null, "unknown usage must not invent counts");

      const rows = await prisma.runAsTenant(tenantA.id, () =>
        prisma.aiBudgetCounter.findMany({ where: { tenantId: tenantA.id } }),
      );
      assert(
        rows.every((r) => r.reservedTokens === 4_000),
        `conservative reservation must stand (4000), got ${rows.map((r) => r.reservedTokens).join(",")}`,
      );

      await prisma.runAsSystem(() =>
        prisma.aiBudgetCounter.deleteMany({ where: { tenantId: tenantA.id } }),
      );
      await prisma.runAsSystem(() =>
        prisma.aiBudgetLedger.deleteMany({ where: { tenantId: tenantA.id } }),
      );

      return "unknown usage -> full reservation kept, uncertain=true, no invented counts";
    });

    // ---------- A5: pre-dispatch release + idempotency ---------- //
    await scenario("A5 pre-dispatch release", async () => {
      const entry = await prisma.runAsTenant(tenantA.id, () =>
        budget.reserve(inputA("inv-a5"), limits),
      );
      await prisma.runAsTenant(tenantA.id, () =>
        budget.release(entry.id, "CANCELLED"),
      );
      await prisma.runAsTenant(tenantA.id, () =>
        budget.release(entry.id, "CANCELLED"),
      );

      const row = await prisma.runAsTenant(tenantA.id, () =>
        prisma.aiBudgetLedger.findUnique({ where: { id: entry.id } }),
      );
      assert(row?.status === "RELEASED", `status must be RELEASED, got ${row?.status}`);

      const rows = await prisma.runAsTenant(tenantA.id, () =>
        prisma.aiBudgetCounter.findMany({ where: { tenantId: tenantA.id } }),
      );
      assert(
        rows.every((r) => r.reservedTokens === 0),
        `released reservations must be refunded exactly once (0), got ${rows.map((r) => r.reservedTokens).join(",")}`,
      );

      await prisma.runAsSystem(() =>
        prisma.aiBudgetCounter.deleteMany({ where: { tenantId: tenantA.id } }),
      );
      await prisma.runAsSystem(() =>
        prisma.aiBudgetLedger.deleteMany({ where: { tenantId: tenantA.id } }),
      );

      return "release -> full refund once, second release is a no-op";
    });

    // ---------- A6: interrupted settlement recovery ---------- //
    await scenario("A6 interrupted settlement recovery", async () => {
      const entry = await prisma.runAsTenant(tenantA.id, () =>
        budget.reserve(inputA("inv-a6"), limits),
      );
      // Simulate a crash mid-flight: age the PENDING row.
      await prisma.runAsSystem(() =>
        prisma.aiBudgetLedger.update({
          where: { id: entry.id },
          data: { createdAt: new Date(Date.now() - 120_000) },
        }),
      );

      const settled = await prisma.runAsSystem(() =>
        budget.settleAbandoned({ olderThanMs: 60_000 }),
      );
      assert(settled >= 1, `recovery must settle the stale entry, settled=${settled}`);

      const row = await prisma.runAsTenant(tenantA.id, () =>
        prisma.aiBudgetLedger.findUnique({ where: { id: entry.id } }),
      );
      assert(row?.status === "SETTLED", `status must be SETTLED, got ${row?.status}`);
      assert(row?.uncertain === true, "recovered entries must be uncertain");
      assert(row?.actualTokens === null, "recovery must not invent usage");

      const rows = await prisma.runAsTenant(tenantA.id, () =>
        prisma.aiBudgetCounter.findMany({ where: { tenantId: tenantA.id } }),
      );
      assert(
        rows.every((r) => r.reservedTokens === 4_000),
        "recovery must keep the conservative reservation (no incorrect refund)",
      );

      const again = await prisma.runAsSystem(() =>
        budget.settleAbandoned({ olderThanMs: 60_000 }),
      );
      assert(again === 0, `recovery must be idempotent, settled ${again} more`);

      await prisma.runAsSystem(() =>
        prisma.aiBudgetCounter.deleteMany({ where: { tenantId: tenantA.id } }),
      );
      await prisma.runAsSystem(() =>
        prisma.aiBudgetLedger.deleteMany({ where: { tenantId: tenantA.id } }),
      );

      return "stale PENDING -> settled conservative + uncertain; rerun settles nothing";
    });

    // ---------- A7: daily/monthly exhaustion + period rollover ---------- //
    await scenario("A7 daily/monthly exhaustion + rollover", async () => {
      const now = day(0);
      const roomy = { dailyTokenLimit: 4_000, monthlyTokenLimit: 8_000 };
      await prisma.runAsTenant(tenantA.id, () =>
        budget.reserve({ ...inputA("inv-a7-1"), now }, roomy),
      );

      const dailyError = await prisma
        .runAsTenant(tenantA.id, () =>
          budget.reserve({ ...inputA("inv-a7-2"), now }, roomy),
        )
        .then(
          () => null,
          (e: unknown) => e,
        );
      assert(
        dailyError instanceof BudgetExceededError &&
          dailyError.limitKind === "tenant_daily_tokens",
        `expected tenant_daily_tokens exhaustion, got ${String(dailyError)}`,
      );

      // A fresh DAY period reopens the daily budget (monthly still binds).
      const rolled = await prisma.runAsTenant(tenantA.id, () =>
        budget.reserve({ ...inputA("inv-a7-3"), now: day(1) }, roomy),
      );
      assert(rolled.reservedTokens === 4_000, "next-day reservation must succeed");

      // Monthly headroom (8000) is now exhausted (4000 + 4000): a
      // reservation that fits the daily limit must still be refused.
      const monthlyError = await prisma
        .runAsTenant(tenantA.id, () =>
          budget.reserve({ ...inputA("inv-a7-4"), now: day(1) }, {
            dailyTokenLimit: 40_000,
            monthlyTokenLimit: 8_000,
          }),
        )
        .then(
          () => null,
          (e: unknown) => e,
        );
      assert(
        monthlyError instanceof BudgetExceededError &&
          monthlyError.limitKind === "tenant_monthly_tokens",
        `expected tenant_monthly_tokens exhaustion, got ${String(monthlyError)}`,
      );

      await prisma.runAsSystem(() =>
        prisma.aiBudgetCounter.deleteMany({ where: { tenantId: tenantA.id } }),
      );
      await prisma.runAsSystem(() =>
        prisma.aiBudgetLedger.deleteMany({ where: { tenantId: tenantA.id } }),
      );

      return "daily exhaustion -> tenant_daily_tokens; fresh day reopens; monthly exhaustion -> tenant_monthly_tokens";
    });

    // ---------- A8: tenant isolation (counter + RLS) ---------- //
    await scenario("A8 tenant isolation (counters + RLS)", async () => {
      await prisma.runAsTenant(tenantA.id, () =>
        budget.reserve(inputA("inv-a8-a"), limits),
      );

      // Tenant B's budget is untouched: a reservation of the same size works.
      const bEntry = await prisma.runAsTenant(tenantB.id, () =>
        budget.reserve(
          {
            tenantId: tenantB.id,
            storeId: storeB.id,
            investigationId: "inv-a8-b",
            tokens: 4_000,
          },
          limits,
        ),
      );
      assert(bEntry.reservedTokens === 4_000, "tenant B must have its own budget");

      // RLS: tenant A's context sees ONLY tenant A's ledger rows.
      const visibleFromA = await prisma.runAsTenant(tenantA.id, () =>
        prisma.aiBudgetLedger.findMany({ where: {} }),
      );
      assert(
        visibleFromA.every((r) => r.tenantId === tenantA.id),
        "RLS must hide foreign ledger rows from tenant A",
      );
      assert(
        visibleFromA.some((r) => r.investigationId === "inv-a8-a"),
        "tenant A must see its own rows",
      );

      const visibleFromB = await prisma.runAsTenant(tenantB.id, () =>
        prisma.aiBudgetCounter.findMany({ where: {} }),
      );
      assert(
        visibleFromB.every((r) => r.tenantId === tenantB.id),
        "RLS must hide foreign counters from tenant B",
      );

      await prisma.runAsSystem(() =>
        prisma.aiBudgetCounter.deleteMany({ where: {} }),
      );
      await prisma.runAsSystem(() =>
        prisma.aiBudgetLedger.deleteMany({ where: {} }),
      );

      return "tenant A exhausted budget -> tenant B unaffected; RLS hides foreign rows both ways";
    });

    // ---------- A9: retries cannot bypass ---------- //
    await scenario("A9 retries cannot bypass an exhausted budget", async () => {
      await prisma.runAsTenant(tenantA.id, () =>
        budget.reserve(inputA("inv-a9-1"), limits),
      );

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const error = await prisma
          .runAsTenant(tenantA.id, () =>
            budget.reserve(inputA(`inv-a9-retry-${attempt}`), limits),
          )
          .then(
            () => null,
            (e: unknown) => e,
          );
        assert(
          error instanceof BudgetExceededError,
          `retry ${attempt} must not bypass the exhausted budget`,
        );
      }

      await prisma.runAsSystem(() =>
        prisma.aiBudgetCounter.deleteMany({ where: { tenantId: tenantA.id } }),
      );
      await prisma.runAsSystem(() =>
        prisma.aiBudgetLedger.deleteMany({ where: { tenantId: tenantA.id } }),
      );

      return "3 sequential retries after exhaustion -> all rejected";
    });

    // ---------- A10: cross-attempt per-investigation summary ---------- //
    await scenario("A10 cross-attempt usage summary", async () => {
      const summary0 = await prisma.runAsTenant(tenantA.id, () =>
        budget.usageSummary("inv-a10"),
      );
      assert(
        summary0.entries === 0 && summary0.reservedTokens === 0,
        `fresh investigation must start empty, got ${JSON.stringify(summary0)}`,
      );

      await prisma.runAsTenant(tenantA.id, () =>
        budget.reserve(inputA("inv-a10", 2_000), {
          dailyTokenLimit: 40_000,
          monthlyTokenLimit: 40_000,
        }),
      );
      await prisma.runAsTenant(tenantA.id, () =>
        budget.reserve(inputA("inv-a10", 1_500), {
          dailyTokenLimit: 40_000,
          monthlyTokenLimit: 40_000,
        }),
      );

      const summary = await prisma.runAsTenant(tenantA.id, () =>
        budget.usageSummary("inv-a10"),
      );
      assert(
        summary.entries === 2 && summary.reservedTokens === 3_500,
        `two attempts must share one investigation budget, got ${JSON.stringify(summary)}`,
      );

      await prisma.runAsSystem(() =>
        prisma.aiBudgetCounter.deleteMany({ where: { tenantId: tenantA.id } }),
      );
      await prisma.runAsSystem(() =>
        prisma.aiBudgetLedger.deleteMany({ where: { tenantId: tenantA.id } }),
      );

      return "2 attempts -> entries=2, reservedTokens=3500 (shared per-investigation budget)";
    });

    // ---------- A11: usage rows + honest provenance + versioned cost ---------- //
    await scenario("A11 usage rows: provenance + versioned cost", async () => {
      // REPORTED usage on a priced model -> CALCULATED integer-micros cost
      // carrying the pricing version.
      await prisma.runAsTenant(tenantA.id, () =>
        usage.recordModelCall({
          ...inputA("inv-a11", 0),
          provider: "groq",
          model: "llama-3.1-8b-instant",
          usage: {
            inputTokens: 1_000,
            outputTokens: 500,
            totalTokens: 1_500,
            source: "REPORTED",
          },
          outcome: "SUCCESS",
          latencyMs: 123,
        }),
      );

      // ESTIMATED usage (test double provenance) on an UNLISTED model ->
      // cost unknown, represented as nulls — never zero.
      await prisma.runAsTenant(tenantA.id, () =>
        usage.recordModelCall({
          ...inputA("inv-a11", 0),
          provider: "test",
          model: "unlisted-model",
          usage: {
            inputTokens: 5,
            outputTokens: 5,
            totalTokens: 10,
            source: "ESTIMATED",
          },
          outcome: "SUCCESS",
        }),
      );

      // UNKNOWN usage (timeout) on a priced model -> counts stay null,
      // cost NOT_CALCULABLE.
      await prisma.runAsTenant(tenantA.id, () =>
        usage.recordModelCall({
          ...inputA("inv-a11", 0),
          provider: "groq",
          model: "llama-3.1-8b-instant",
          usage: {
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
            source: "UNKNOWN",
          },
          outcome: "TIMEOUT",
          failureCode: "TIMEOUT",
        }),
      );

      const rows = await prisma.runAsTenant(tenantA.id, () =>
        prisma.aiModelCall.findMany({
          where: { investigationId: "inv-a11" },
          orderBy: { occurredAt: "asc" },
        }),
      );
      assert(rows.length === 3, `expected 3 usage rows, got ${rows.length}`);

      const reported = rows[0];
      const estimated = rows[1];
      const unknown = rows[2];
      assert(
        reported && estimated && unknown,
        "expected exactly three usage rows",
      );
      assert(
        reported.usageSource === "REPORTED" &&
          reported.inputTokens === 1_000 &&
          reported.outputTokens === 500 &&
          reported.totalTokens === 1_500,
        "provider-reported usage must be preserved verbatim",
      );
      assert(
        reported.costStatus === "CALCULATED" &&
          reported.pricingVersion === pricing.pricingVersion &&
          reported.currency === pricing.currency,
        `cost must carry the pricing version (${pricing.pricingVersion}), got ${reported.costStatus}/${reported.pricingVersion}`,
      );
      assert(
        reported.inputCostMicros !== null &&
          reported.inputCostMicros > 0n &&
          reported.outputCostMicros !== null &&
          reported.totalCostMicros ===
            reported.inputCostMicros + reported.outputCostMicros,
        "input/output costs must be separate integer micros summing to the total",
      );

      assert(
        estimated.usageSource === "ESTIMATED" &&
          estimated.costStatus === "UNKNOWN_PRICING" &&
          estimated.totalCostMicros === null,
        "unknown pricing must be explicit nulls — never zero cost",
      );

      assert(
        unknown.usageSource === "UNKNOWN" &&
          unknown.inputTokens === null &&
          unknown.outputTokens === null &&
          unknown.totalTokens === null &&
          unknown.costStatus === "NOT_CALCULABLE" &&
          unknown.totalCostMicros === null,
        "unknown usage must be null counts with NOT_CALCULABLE cost, never invented",
      );

      // RLS isolation for usage rows as well.
      const foreign = await prisma.runAsTenant(tenantB.id, () =>
        prisma.aiModelCall.findMany({
          where: { investigationId: "inv-a11" },
        }),
      );
      assert(foreign.length === 0, "RLS must hide tenant A usage rows from tenant B");

      return "3 rows: REPORTED+CALCULATED(versioned), ESTIMATED+UNKNOWN_PRICING(nulls), UNKNOWN+NOT_CALCULABLE";
    });

    // ---------- A12: operator tenant budget override ---------- //
    await scenario("A12 operator tenant budget override", async () => {
      await prisma.runAsTenant(tenantA.id, () =>
        prisma.aiTenantBudgetLimit.create({
          data: {
            tenantId: tenantA.id,
            dailyTokenLimit: 1_000,
            monthlyTokenLimit: 1_000,
            updatedBy: "operator-test",
          },
        }),
      );

      const effective = await prisma.runAsTenant(tenantA.id, () =>
        budget.limitsFor(tenantA.id, {
          dailyTokenLimit: 4_000,
          monthlyTokenLimit: 4_000,
        }),
      );
      assert(
        effective.dailyTokenLimit === 1_000 && effective.monthlyTokenLimit === 1_000,
        `override must win over defaults, got ${JSON.stringify(effective)}`,
      );

      const error = await prisma
        .runAsTenant(tenantA.id, () =>
          budget.reserve(inputA("inv-a12", 2_000), effective),
        )
        .then(
          () => null,
          (e: unknown) => e,
        );
      assert(
        error instanceof BudgetExceededError,
        "reservation above the operator override must be rejected",
      );

      const untouched = await prisma.runAsTenant(tenantB.id, () =>
        budget.limitsFor(tenantB.id, {
          dailyTokenLimit: 4_000,
          monthlyTokenLimit: 4_000,
        }),
      );
      assert(
        untouched.dailyTokenLimit === 4_000,
        "other tenants must keep the configured defaults",
      );

      await prisma.runAsSystem(() =>
        prisma.aiTenantBudgetLimit.deleteMany({ where: {} }),
      );
      await prisma.runAsSystem(() =>
        prisma.aiBudgetCounter.deleteMany({ where: {} }),
      );
      await prisma.runAsSystem(() =>
        prisma.aiBudgetLedger.deleteMany({ where: {} }),
      );

      return "override 1000 beats default 4000; other tenants unaffected";
    });

    // ---------- A13: guarded failureCode persistence ---------- //
    await scenario("A13 guarded failureCode persistence", async () => {
      const exception = await prisma.runAsTenant(tenantA.id, () =>
        exceptionService.createOrUpdateException({
          tenantId: tenantA.id,
          storeId: storeA.id,
          fingerprint: `acct-failure-${Date.now()}`,
          category: "INVENTORY_SHORTAGE",
          severity: "HIGH",
          title: "Accounting failure-code test exception",
          evidence: { source: "accounting-real-db-test" },
          recommendedNextStep: "none — test fixture",
        }),
      );

      const investigation = await prisma.runAsTenant(tenantA.id, () =>
        prisma.aiInvestigation.create({
          data: {
            tenantId: tenantA.id,
            storeId: storeA.id,
            exceptionId: exception.id,
            model: "accounting-test",
            status: "RUNNING",
            executionClaimId: "claim-a13",
          },
        }),
      );

      // The same guarded transition markFailed performs.
      await prisma.runAsTenant(tenantA.id, () =>
        prisma.aiInvestigation.updateMany({
          where: {
            id: investigation.id,
            status: "RUNNING",
            executionClaimId: "claim-a13",
          },
          data: {
            status: "FAILED",
            completedAt: new Date(),
            error: "tenant daily token budget exhausted",
            failureCode: "BUDGET_EXCEEDED",
          },
        }),
      );

      const row = await prisma.runAsTenant(tenantA.id, () =>
        prisma.aiInvestigation.findUnique({
          where: { id: investigation.id },
        }),
      );
      assert(row?.failureCode === "BUDGET_EXCEEDED", `failureCode must persist, got ${row?.failureCode}`);
      assert(row?.status === "FAILED", `status must be FAILED, got ${row?.status}`);

      // A late second finisher with a stale claim must not overwrite it.
      const second = await prisma.runAsTenant(tenantA.id, () =>
        prisma.aiInvestigation.updateMany({
          where: {
            id: investigation.id,
            status: "RUNNING",
            executionClaimId: "claim-late",
          },
          data: { status: "FAILED", failureCode: "CANCELLED" },
        }),
      );
      assert(second.count === 0, "a stale claim must never overwrite the terminal state");

      const unchanged = await prisma.runAsTenant(tenantA.id, () =>
        prisma.aiInvestigation.findUnique({
          where: { id: investigation.id },
        }),
      );
      assert(
        unchanged?.failureCode === "BUDGET_EXCEEDED",
        "the recorded classification must be immutable",
      );

      return "failureCode persisted under the lease guard; stale claim cannot overwrite";
    });

    // ---------- summary ---------- //
    const passed = SCENARIO_RESULTS.filter((r) => r.ok).length;
    console.log("\n================ SUMMARY ================");
    for (const r of SCENARIO_RESULTS) {
      console.log(`${r.ok ? "PASS" : "FAIL"} ${r.scenario}: ${r.detail}`);
    }
    console.log(
      `ai-runtime-accounting-real-db-test: ${passed}/${SCENARIO_RESULTS.length} scenarios PASSED`,
    );
    if (passed !== SCENARIO_RESULTS.length) {
      throw new Error("accounting real-DB suite FAILED");
    }
  } finally {
    // Close with a hard bound: broker-less teardown can stall on ioredis
    // reconnects, and a test process must never hang after its verdict.
    await Promise.race([
      moduleRef.close().catch(() => undefined),
      sleep(3_000),
    ]);
    await prisma.$disconnect().catch(() => undefined);
  }
}

process.env.AI_INVESTIGATION_TIMEOUT_MS ??= "3000";

main()
  .then(() => {
    console.log("DONE");
    process.exit(0);
  })
  .catch((error) => {
    console.error("FATAL", error);
    process.exit(1);
  });

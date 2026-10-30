import { describe, expect, it } from "vitest";

import {
  AiBudgetService,
  BudgetExceededError,
} from "./ai-budget.service";

type Counter = {
  tenantId: string;
  periodKind: string;
  periodKey: string;
  reservedTokens: number;
};

type LedgerRow = {
  id: string;
  tenantId: string;
  storeId: string;
  investigationId: string;
  periodDay: string;
  periodMonth: string;
  reservedTokens: number;
  actualTokens: number | null;
  usageSource: string;
  status: string;
  uncertain: boolean;
  createdAt: Date;
  settledAt: Date | null;
};

/**
 * Deterministic single-threaded model of the SQL the service runs. The REAL
 * atomicity/isolation guarantees are proven against PostgreSQL in
 * ai-runtime-accounting-real-db-test.ts; this fake verifies the CONTRACT of
 * the guarded statements (conditional increment, idempotent transitions).
 */
function makeFakePrisma() {
  const counters = new Map<string, Counter>();
  const ledger = new Map<string, LedgerRow>();
  let nextId = 1;

  const counterKey = (t: string, k: string, p: string) => `${t}|${k}|${p}`;

  const prisma = {
    aiBudgetCounter: {
      upsert: async (args: {
        where: { tenantId_periodKind_periodKey: Counter };
        create: Counter;
      }) => {
        const { tenantId, periodKind, periodKey } =
          args.where.tenantId_periodKind_periodKey;
        const key = counterKey(tenantId, periodKind, periodKey);
        if (!counters.has(key)) {
          counters.set(key, { ...args.create, reservedTokens: 0 });
        }
        return counters.get(key);
      },
      findUnique: async (args: {
        where: { tenantId_periodKind_periodKey: Counter };
      }) => {
        const { tenantId, periodKind, periodKey } =
          args.where.tenantId_periodKind_periodKey;
        return counters.get(counterKey(tenantId, periodKind, periodKey)) ?? null;
      },
      updateMany: async (args: {
        where: {
          tenantId: string;
          periodKind: string;
          periodKey: string;
          reservedTokens?: { lte: number };
        };
        data: { reservedTokens: { increment: number } };
      }) => {
        const key = counterKey(
          args.where.tenantId,
          args.where.periodKind,
          args.where.periodKey,
        );
        const row = counters.get(key);
        if (!row) return { count: 0 };
        const guard = args.where.reservedTokens;
        // Same semantics as SQL `WHERE "reservedTokens" <= $limit - $x` on
        // an UPDATE ... SET "reservedTokens" = "reservedTokens" + $x.
        if (guard && !(row.reservedTokens <= guard.lte)) return { count: 0 };
        row.reservedTokens += args.data.reservedTokens.increment;
        return { count: 1 };
      },
    },
    aiBudgetLedger: {
      create: async (args: { data: Omit<LedgerRow, "id" | "createdAt" | "settledAt" | "actualTokens" | "usageSource" | "uncertain"> }) => {
        const row: LedgerRow = {
          id: `ledger-${nextId++}`,
          actualTokens: null,
          usageSource: "UNKNOWN",
          uncertain: false,
          createdAt: new Date(),
          settledAt: null,
          ...args.data,
        };
        ledger.set(row.id, row);
        return row;
      },
      findUnique: async (args: { where: { id: string } }) =>
        ledger.get(args.where.id) ?? null,
      findMany: async (args: {
        where: { status: string; createdAt: { lt: Date } };
      }) =>
        [...ledger.values()].filter(
          (row) =>
            row.status === args.where.status &&
            row.createdAt < args.where.createdAt.lt,
        ),
      count: async (args: { where: { investigationId: string } }) =>
        [...ledger.values()].filter(
          (row) => row.investigationId === args.where.investigationId,
        ).length,
      aggregate: async (args: {
        where: { investigationId: string };
        _sum: { reservedTokens: boolean };
      }) => ({
        _sum: {
          reservedTokens: [...ledger.values()]
            .filter((row) => row.investigationId === args.where.investigationId)
            .reduce((sum, row) => sum + row.reservedTokens, 0),
        },
      }),
      updateMany: async (args: {
        where: { id: string; status: string };
        data: Partial<LedgerRow>;
      }) => {
        const row = ledger.get(args.where.id);
        if (!row || row.status !== args.where.status) return { count: 0 };
        Object.assign(row, args.data);
        return { count: 1 };
      },
    },
    aiTenantBudgetLimit: {
      findUnique: async () => null,
    },
    // Mirrors SQL transaction semantics: any throw inside the callback
    // rolls every statement in the transaction back.
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const counterSnap = [...counters].map(([k, v]) => [k, { ...v }] as const);
      const ledgerSnap = [...ledger].map(([k, v]) => [k, { ...v }] as const);
      try {
        return await fn(prisma);
      } catch (error) {
        counters.clear();
        for (const [k, v] of counterSnap) counters.set(k, v);
        ledger.clear();
        for (const [k, v] of ledgerSnap) ledger.set(k, v);
        throw error;
      }
    },
  };

  return { prisma, counters, ledger };
}

function first<T>(values: Iterable<T>): T {
  for (const value of values) {
    return value;
  }
  throw new Error("expected at least one element");
}

const limits = { dailyTokenLimit: 10_000, monthlyTokenLimit: 20_000 };
const baseInput = {
  tenantId: "tenant-1",
  storeId: "store-1",
  investigationId: "inv-1",
  tokens: 4_000,
};

describe("AiBudgetService (Phase 2C)", () => {
  it("reserves atomically and records a PENDING ledger entry", async () => {
    const { prisma, counters, ledger } = makeFakePrisma();
    const budget = new AiBudgetService(prisma as never);

    const entry = await budget.reserve(baseInput, limits);

    expect(entry.reservedTokens).toBe(4_000);
    expect(first(ledger.values()).status).toBe("PENDING");
    // One DAY and one MONTH counter, each holding the reservation.
    expect([...counters.values()].map((c) => c.periodKind).sort()).toEqual([
      "DAY",
      "MONTH",
    ]);
    expect([...counters.values()].map((c) => c.reservedTokens).sort()).toEqual([
      4_000, 4_000,
    ]);
  });

  it("two concurrent investigations cannot both spend the same budget", async () => {
    const { prisma } = makeFakePrisma();
    const budget = new AiBudgetService(prisma as never);
    const tight = { dailyTokenLimit: 4_000, monthlyTokenLimit: 4_000 };

    // Interleaved at the statement level by the fake: both attempts see the
    // same starting state, exactly one conditional increment succeeds.
    const [a, b] = await Promise.allSettled([
      budget.reserve({ ...baseInput, investigationId: "inv-a" }, tight),
      budget.reserve({ ...baseInput, investigationId: "inv-b" }, tight),
    ]);

    const fulfilled = [a, b].filter((r) => r.status === "fulfilled");
    const rejected = [a, b].filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const loss = first(rejected);
    expect(loss.reason).toBeInstanceOf(BudgetExceededError);
    expect((loss.reason as BudgetExceededError).code).toBe("BUDGET_EXCEEDED");
  });

  it("daily and monthly exhaustion are reported with the right limit kind", async () => {
    const { prisma } = makeFakePrisma();
    const budget = new AiBudgetService(prisma as never);

    await budget.reserve(baseInput, {
      dailyTokenLimit: 5_000,
      monthlyTokenLimit: 40_000,
    });

    await expect(
      budget.reserve(
        { ...baseInput, tokens: 2_000 },
        { dailyTokenLimit: 5_000, monthlyTokenLimit: 40_000 },
      ),
    ).rejects.toMatchObject({ limitKind: "tenant_daily_tokens" });

    await expect(
      budget.reserve(
        { ...baseInput, tokens: 1_000 },
        { dailyTokenLimit: 40_000, monthlyTokenLimit: 4_500 },
      ),
    ).rejects.toMatchObject({ limitKind: "tenant_monthly_tokens" });
  });

  it("settlement is idempotent — a second settle never double-moves counters", async () => {
    const { prisma, counters } = makeFakePrisma();
    const budget = new AiBudgetService(prisma as never);

    const entry = await budget.reserve(baseInput, limits);
    await budget.settle({
      entryId: entry.id,
      actualTokens: 1_000,
      usageSource: "REPORTED",
    });
    await budget.settle({
      entryId: entry.id,
      actualTokens: 1_000,
      usageSource: "REPORTED",
    });

    const totals = [...counters.values()].map((c) => c.reservedTokens).sort();
    // reserved 4000, settled 1000 -> counters hold the accounted 1000 once.
    expect(totals).toEqual([1_000, 1_000]);
  });

  it("unknown usage keeps the conservative reservation and is marked uncertain", async () => {
    const { prisma, counters, ledger } = makeFakePrisma();
    const budget = new AiBudgetService(prisma as never);

    const entry = await budget.reserve(baseInput, limits);
    await budget.settle({
      entryId: entry.id,
      actualTokens: null,
      usageSource: "UNKNOWN",
      usageDisposition: "unknown",
    });

    const row = first(ledger.values());
    expect(row.status).toBe("SETTLED");
    expect(row.uncertain).toBe(true);
    expect(row.actualTokens).toBeNull();
    // No incorrect refund: the full reservation stands.
    expect([...counters.values()].map((c) => c.reservedTokens).sort()).toEqual([
      4_000, 4_000,
    ]);
  });

  it("pre-dispatch failures (usageDisposition none) release the reservation in full", async () => {
    const { prisma, counters, ledger } = makeFakePrisma();
    const budget = new AiBudgetService(prisma as never);

    const entry = await budget.reserve(baseInput, limits);
    await budget.release(entry.id, "CANCELLED");

    const row = first(ledger.values());
    expect(row.status).toBe("RELEASED");
    expect([...counters.values()].map((c) => c.reservedTokens).sort()).toEqual([
      0, 0,
    ]);
  });

  it("retries after exhaustion cannot bypass the budget (new reservation, same counters)", async () => {
    const { prisma } = makeFakePrisma();
    const budget = new AiBudgetService(prisma as never);
    const tight = { dailyTokenLimit: 4_000, monthlyTokenLimit: 4_000 };

    await budget.reserve(baseInput, tight);
    await expect(
      budget.reserve({ ...baseInput }, tight),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    await expect(
      budget.reserve({ ...baseInput }, tight),
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("settleAbandoned recovers interrupted settlements conservatively", async () => {
    const { prisma, ledger, counters } = makeFakePrisma();
    const budget = new AiBudgetService(prisma as never);

    const entry = await budget.reserve(baseInput, limits);
    // Simulate a crash before settlement: force createdAt into the past.
    first(ledger.values()).createdAt = new Date(Date.now() - 60_000);

    const settled = await budget.settleAbandoned({ olderThanMs: 30_000 });

    expect(settled).toBe(1);
    const row = first(ledger.values());
    expect(row.status).toBe("SETTLED");
    expect(row.uncertain).toBe(true);
    expect([...counters.values()].map((c) => c.reservedTokens).sort()).toEqual([
      4_000, 4_000,
    ]);

    // Idempotent: running recovery again settles nothing new.
    expect(await budget.settleAbandoned({ olderThanMs: 30_000 })).toBe(0);
    expect(entry.reservedTokens).toBe(4_000);
  });

  it("reports cross-attempt usage per investigation (retries share one budget)", async () => {
    const { prisma } = makeFakePrisma();
    const budget = new AiBudgetService(prisma as never);

    await budget.reserve({ ...baseInput }, limits);
    await budget.reserve({ ...baseInput }, limits);

    const summary = await budget.usageSummary("inv-1");
    expect(summary).toEqual({ entries: 2, reservedTokens: 8_000 });
  });
});

import { Injectable, Logger } from "@nestjs/common";
import type {
  AiBudgetLedgerStatus,
  AiBudgetPeriodKind,
  Prisma,
} from "@prisma/client";

import { PrismaService } from "../../prisma/prisma.service";
import type { LlmUsage } from "../llm/llm-client.interface";

export type BudgetPeriod = {
  day: string;
  month: string;
};

export type BudgetEntry = {
  id: string;
  reservedTokens: number;
};

/**
 * Thrown when a reservation would exceed a configured budget limit. The
 * job worker treats this as a PERMANENT outcome: it is recorded as a
 * BUDGET_EXCEEDED failure and is never retried or converted into an
 * approved action.
 */
export class BudgetExceededError extends Error {
  readonly code = "BUDGET_EXCEEDED" as const;
  readonly limitKind:
    | "investigation_model_calls"
    | "investigation_tokens"
    | "tenant_daily_tokens"
    | "tenant_monthly_tokens";
  readonly limit: number;
  readonly requested: number;
  readonly reserved: number;

  constructor(input: {
    limitKind:
      | "investigation_model_calls"
      | "investigation_tokens"
      | "tenant_daily_tokens"
      | "tenant_monthly_tokens";
    limit: number;
    requested: number;
    reserved: number;
  }) {
    super(
      `Tenant token budget exhausted (${input.limitKind}): limit ${input.limit}, already reserved ${input.reserved}, requested ${input.requested}`,
    );
    this.name = "BudgetExceededError";
    this.limitKind = input.limitKind;
    this.limit = input.limit;
    this.requested = input.requested;
    this.reserved = input.reserved;
  }
}

export type ReserveInput = {
  tenantId: string;
  storeId: string;
  investigationId: string;
  tokens: number;
  now?: Date;
};

export type SettlementInput = {
  entryId: string;
  /** Actual provider-reported/estimated tokens, or null when unknown. */
  actualTokens: number | null;
  usageSource: LlmUsage["source"];
  /** "none" = request never left (full refund); "unknown" = keep reservation. */
  usageDisposition?: "none" | "unknown";
};

export type DailyMonthlyLimits = {
  dailyTokenLimit: number;
  monthlyTokenLimit: number;
};

/**
 * Phase 2C: atomic, DB-backed token budgets.
 *
 * Reservation (BEFORE any model call) is the atomic conditional increment
 *     UPDATE "AiBudgetCounter" SET "reservedTokens" = "reservedTokens" + x
 *     WHERE tenant/kind/key AND "reservedTokens" <= limit - x
 * inside one transaction with the ledger insert. When two investigations
 * race for the same remaining budget exactly one gets the rows; the other
 * receives BudgetExceededError. Retries create NEW reservations against
 * the same counters, so they cannot bypass an exhausted budget.
 *
 * Settlement is a guarded PENDING -> SETTLED transition (idempotent): the
 * counters move by (accounted - reserved) exactly once. Unknown usage
 * keeps the conservative reservation and is marked uncertain — never
 * silently refunded. A pre-dispatch failure (usageDisposition "none")
 * releases the reservation entirely.
 */
@Injectable()
export class AiBudgetService {
  private readonly logger = new Logger(AiBudgetService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Public entry: applies tenant overrides over the configured defaults. */
  async limitsFor(
    tenantId: string,
    defaults: DailyMonthlyLimits,
  ): Promise<DailyMonthlyLimits> {
    const override = await this.prisma.aiTenantBudgetLimit.findUnique({
      where: { tenantId },
    });

    return {
      dailyTokenLimit:
        override?.dailyTokenLimit != null
          ? override.dailyTokenLimit
          : defaults.dailyTokenLimit,
      monthlyTokenLimit:
        override?.monthlyTokenLimit != null
          ? override.monthlyTokenLimit
          : defaults.monthlyTokenLimit,
    };
  }

  async reserve(
    input: ReserveInput,
    limits: DailyMonthlyLimits,
  ): Promise<BudgetEntry> {
    const tokens = Math.max(0, Math.floor(input.tokens));
    const now = input.now ?? new Date();
    const day = now.toISOString().slice(0, 10);
    const month = now.toISOString().slice(0, 7);

    // Counter materialization happens OUTSIDE the reservation transaction:
    // concurrent upserts can race on the unique key, and a constraint
    // failure inside a transaction poisons it (PostgreSQL 25P02). A lost
    // insert race means the row exists — exactly the upsert's intent.
    await this.ensureCounter(input.tenantId, "DAY", day);
    await this.ensureCounter(input.tenantId, "MONTH", month);

    return this.prisma.$transaction(async (tx) => {

      // Atomic conditional reservation per period. updateMany cannot
      // reference another column in `where`, so the guard is expressed as
      // reservedTokens <= limit - tokens (equivalent to reserved + tokens
      // <= limit) — evaluated atomically by the database.
      const daily = await tx.aiBudgetCounter.updateMany({
        where: {
          tenantId: input.tenantId,
          periodKind: "DAY",
          periodKey: day,
          reservedTokens: { lte: limits.dailyTokenLimit - tokens },
        },
        data: { reservedTokens: { increment: tokens } },
      });

      if (daily.count === 0) {
        throw new BudgetExceededError({
          limitKind: "tenant_daily_tokens",
          limit: limits.dailyTokenLimit,
          requested: tokens,
          reserved: await this.reservedFor(tx, input.tenantId, "DAY", day),
        });
      }

      const monthly = await tx.aiBudgetCounter.updateMany({
        where: {
          tenantId: input.tenantId,
          periodKind: "MONTH",
          periodKey: month,
          reservedTokens: { lte: limits.monthlyTokenLimit - tokens },
        },
        data: { reservedTokens: { increment: tokens } },
      });

      if (monthly.count === 0) {
        throw new BudgetExceededError({
          limitKind: "tenant_monthly_tokens",
          limit: limits.monthlyTokenLimit,
          requested: tokens,
          reserved: await this.reservedFor(tx, input.tenantId, "MONTH", month),
        });
      }

      const entry = await tx.aiBudgetLedger.create({
        data: {
          tenantId: input.tenantId,
          storeId: input.storeId,
          investigationId: input.investigationId,
          periodDay: day,
          periodMonth: month,
          reservedTokens: tokens,
          status: "PENDING",
        },
      });

      return { id: entry.id, reservedTokens: tokens };
    });
  }

  /**
   * Release a reservation whose request provably never reached the
   * provider (pre-dispatch failure). Idempotent: only a PENDING entry can
   * be released, exactly once.
   */
  async release(entryId: string, reason: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const entry = await tx.aiBudgetLedger.findUnique({
        where: { id: entryId },
      });

      if (!entry || entry.status !== "PENDING") {
        return;
      }

      const claimed = await tx.aiBudgetLedger.updateMany({
        where: { id: entryId, status: "PENDING" },
        data: { status: "RELEASED", settledAt: new Date(), uncertain: false },
      });

      if (claimed.count === 0) {
        return;
      }

      await this.adjustCounters(
        tx,
        entry,
        -entry.reservedTokens,
        -entry.reservedTokens,
      );

      this.logger.log(
        `Budget reservation ${entryId} released (request never dispatched): ${reason}`,
      );
    });
  }

  /**
   * Reconcile one reservation against actual usage. Idempotent: the
   * PENDING -> SETTLED guard means a second call is a no-op. Unknown
   * usage keeps the full reservation and is marked uncertain.
   */
  async settle(input: SettlementInput): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const entry = await tx.aiBudgetLedger.findUnique({
        where: { id: input.entryId },
      });

      if (!entry || entry.status !== "PENDING") {
        return;
      }

      const preDispatch = input.usageDisposition === "none";
      const knownUsage =
        typeof input.actualTokens === "number" &&
        Number.isFinite(input.actualTokens);

      const accounted = preDispatch
        ? 0
        : knownUsage
          ? Math.max(0, Math.floor(input.actualTokens as number))
          : entry.reservedTokens;
      const uncertain = !preDispatch && !knownUsage;

      const claimed = await tx.aiBudgetLedger.updateMany({
        where: { id: input.entryId, status: "PENDING" },
        data: {
          status: "SETTLED",
          actualTokens: knownUsage ? accounted : null,
          usageSource: input.usageSource,
          uncertain,
          settledAt: new Date(),
        },
      });

      if (claimed.count === 0) {
        // Concurrent settlement already happened — nothing to do.
        return;
      }

      await this.adjustCounters(
        tx,
        entry,
        accounted - entry.reservedTokens,
        accounted - entry.reservedTokens,
      );
    });
  }

  /**
   * Recovery: settle reservations abandoned mid-flight (process died
   * between call and settlement). Conservative: the full reservation
   * stands as accounted consumption and the entry is marked uncertain —
   * never incorrectly refunded. Idempotent by the PENDING guard.
   */
  async settleAbandoned(input: {
    olderThanMs: number;
    now?: Date;
  }): Promise<number> {
    const cutoff = new Date(
      (input.now ?? new Date()).getTime() - Math.max(0, input.olderThanMs),
    );

    const stale = await this.prisma.aiBudgetLedger.findMany({
      where: { status: "PENDING", createdAt: { lt: cutoff } },
    });

    let settled = 0;

    for (const entry of stale) {
      await this.settle({
        entryId: entry.id,
        actualTokens: null,
        usageSource: "UNKNOWN",
        usageDisposition: "unknown",
      });
      settled += 1;
    }

    return settled;
  }

  /** Cross-attempt usage summary for one investigation (ledger-backed). */
  async usageSummary(
    investigationId: string,
  ): Promise<{ entries: number; reservedTokens: number }> {
    const [entries, agg] = await Promise.all([
      this.prisma.aiBudgetLedger.count({ where: { investigationId } }),
      this.prisma.aiBudgetLedger.aggregate({
        where: { investigationId },
        _sum: { reservedTokens: true },
      }),
    ]);

    return { entries, reservedTokens: agg._sum.reservedTokens ?? 0 };
  }

  private async ensureCounter(
    tenantId: string,
    periodKind: AiBudgetPeriodKind,
    periodKey: string,
  ): Promise<void> {
    try {
      await this.prisma.aiBudgetCounter.upsert({
        where: {
          tenantId_periodKind_periodKey: { tenantId, periodKind, periodKey },
        },
        create: { tenantId, periodKind, periodKey, reservedTokens: 0 },
        update: {},
      });
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) {
        throw error;
      }
      // A concurrent reservation materialized the same counter first —
      // the row exists, which is all this step guarantees.
    }
  }

  private async reservedFor(
    tx: Prisma.TransactionClient,
    tenantId: string,
    periodKind: AiBudgetPeriodKind,
    periodKey: string,
  ): Promise<number> {
    const row = await tx.aiBudgetCounter.findUnique({
      where: {
        tenantId_periodKind_periodKey: { tenantId, periodKind, periodKey },
      },
    });

    return row?.reservedTokens ?? 0;
  }

  private async adjustCounters(
    tx: Prisma.TransactionClient,
    entry: { tenantId: string; periodDay: string; periodMonth: string },
    dailyDelta: number,
    monthlyDelta: number,
  ): Promise<void> {
    if (dailyDelta === 0 && monthlyDelta === 0) {
      return;
    }

    if (dailyDelta !== 0) {
      await tx.aiBudgetCounter.updateMany({
        where: {
          tenantId: entry.tenantId,
          periodKind: "DAY",
          periodKey: entry.periodDay,
        },
        data: { reservedTokens: { increment: dailyDelta } },
      });
    }

    if (monthlyDelta !== 0) {
      await tx.aiBudgetCounter.updateMany({
        where: {
          tenantId: entry.tenantId,
          periodKind: "MONTH",
          periodKey: entry.periodMonth,
        },
        data: { reservedTokens: { increment: monthlyDelta } },
      });
    }
  }
}

export type { AiBudgetLedgerStatus };

/** P2002 (Prisma) / 23505 (PostgreSQL) unique-constraint violation. */
function isUniqueConstraintViolation(error: unknown): boolean {
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    return code === "P2002" || code === "23505";
  }

  return false;
}

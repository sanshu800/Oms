-- Phase 2C: runtime failure taxonomy, usage/cost accounting, tenant budgets.
--
-- 1) AiModelCall: per-invocation usage accounting (provider/model, token
--    counts with honest provenance (REPORTED|ESTIMATED|UNKNOWN), latency,
--    outcome, and versioned cost (or explicit UNKNOWN_PRICING — never 0).
--    No prompts or credentials are stored.
--
-- 2) AiBudgetLedger: append-only reservation/settlement records. A PENDING
--    row is a conservative token reservation made BEFORE a model call;
--    settlement is a guarded PENDING->SETTLED transition (idempotent) that
--    reconciles the counters against actual usage. Unknown usage keeps the
--    conservative charge and is marked uncertain — never silently refunded.
--
-- 3) AiBudgetCounter: per-tenant period counters (DAY/MONTH) holding the
--    reserved/committed token total. Budget reservation is the atomic
--    conditional increment
--        UPDATE ... SET "reservedTokens" = "reservedTokens" + $x
--        WHERE ... AND "reservedTokens" + $x <= $limit
--    inside one transaction — two concurrent investigations can never both
--    consume the same remaining budget (the loser gets 0 rows -> BUDGET_EXCEEDED).
--
-- 4) AiTenantBudgetLimit: operator-approved per-tenant overrides of the
--    configured default limits (audited service method; no API surface).
--
-- 5) AiInvestigation.failureCode: stable machine-readable RuntimeFailure
--    code for the terminal outcome (existing free-text `error` preserved).

-- ============================================================
-- Enums
-- ============================================================

CREATE TYPE "AiUsageSource" AS ENUM ('REPORTED', 'ESTIMATED', 'UNKNOWN');

CREATE TYPE "AiModelCallOutcome" AS ENUM (
  'SUCCESS',
  'TIMEOUT',
  'CANCELLED',
  'RATE_LIMITED',
  'AUTHENTICATION_FAILED',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_ERROR',
  'INVALID_RESPONSE',
  'INTERNAL_ERROR'
);

CREATE TYPE "AiCostStatus" AS ENUM ('CALCULATED', 'UNKNOWN_PRICING', 'NOT_CALCULABLE');

CREATE TYPE "AiBudgetLedgerStatus" AS ENUM ('PENDING', 'SETTLED', 'RELEASED');

CREATE TYPE "AiBudgetPeriodKind" AS ENUM ('DAY', 'MONTH');

-- ============================================================
-- Tables
-- ============================================================

CREATE TABLE "AiModelCall" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "investigationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "totalTokens" INTEGER,
    "usageSource" "AiUsageSource" NOT NULL DEFAULT 'UNKNOWN',
    "outcome" "AiModelCallOutcome" NOT NULL,
    "failureCode" TEXT,
    "latencyMs" INTEGER,
    "pricingVersion" TEXT,
    "currency" TEXT,
    "inputCostMicros" BIGINT,
    "outputCostMicros" BIGINT,
    "totalCostMicros" BIGINT,
    "costStatus" "AiCostStatus" NOT NULL DEFAULT 'UNKNOWN_PRICING',
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiModelCall_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiModelCall_tenantId_investigationId_idx"
  ON "AiModelCall"("tenantId", "investigationId");
CREATE INDEX "AiModelCall_tenantId_occurredAt_idx"
  ON "AiModelCall"("tenantId", "occurredAt");

CREATE TABLE "AiBudgetLedger" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "investigationId" TEXT NOT NULL,
    "periodDay" TEXT NOT NULL,
    "periodMonth" TEXT NOT NULL,
    "reservedTokens" INTEGER NOT NULL,
    "actualTokens" INTEGER,
    "usageSource" "AiUsageSource" NOT NULL DEFAULT 'UNKNOWN',
    "status" "AiBudgetLedgerStatus" NOT NULL DEFAULT 'PENDING',
    "uncertain" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "AiBudgetLedger_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiBudgetLedger_tenantId_periodDay_idx"
  ON "AiBudgetLedger"("tenantId", "periodDay");
CREATE INDEX "AiBudgetLedger_status_createdAt_idx"
  ON "AiBudgetLedger"("status", "createdAt");
CREATE INDEX "AiBudgetLedger_investigationId_idx"
  ON "AiBudgetLedger"("investigationId");

CREATE TABLE "AiBudgetCounter" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "periodKind" "AiBudgetPeriodKind" NOT NULL,
    "periodKey" TEXT NOT NULL,
    "reservedTokens" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AiBudgetCounter_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiBudgetCounter_tenantId_periodKind_periodKey_key"
  ON "AiBudgetCounter"("tenantId", "periodKind", "periodKey");

CREATE TABLE "AiTenantBudgetLimit" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "dailyTokenLimit" INTEGER,
    "monthlyTokenLimit" INTEGER,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiTenantBudgetLimit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiTenantBudgetLimit_tenantId_key"
  ON "AiTenantBudgetLimit"("tenantId");

-- Stable machine-readable failure classification on the investigation row.
ALTER TABLE "AiInvestigation" ADD COLUMN "failureCode" TEXT;

-- ============================================================
-- RLS: same tenant_isolation policy as every other tenant-scoped
-- table (including the Ai* intelligence tables). Budgets, usage and
-- ledger rows are tenant data and inherit the identical guarantee.
-- ============================================================

ALTER TABLE "AiModelCall" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiModelCall" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AiModelCall"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true));

ALTER TABLE "AiBudgetLedger" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiBudgetLedger" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AiBudgetLedger"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true));

ALTER TABLE "AiBudgetCounter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiBudgetCounter" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AiBudgetCounter"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true));

ALTER TABLE "AiTenantBudgetLimit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiTenantBudgetLimit" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AiTenantBudgetLimit"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true));

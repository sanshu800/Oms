-- Phase 2B: reliable investigation substrate.
--
-- 1) One active investigation per (tenantId, storeId, exceptionId):
--    a partial unique index over RUNNING rows is the only enforcement that
--    is race-free across processes (an application-level "is one running?"
--    check has a TOCTOU window). Concurrent INSERTs of a second RUNNING row
--    fail atomically; the loser attaches to the winner's run.
--
-- 2) Execution lease: a worker claims an investigation row before running
--    its tool loop (executionClaimId/executionClaimedAt). The lease is the
--    persistence-boundary guard that (a) prevents two workers from
--    executing the same investigation lifecycle concurrently, (b) makes
--    "lost claim" detectable so a late result can never finalize a
--    superseded run, and (c) makes abandoned RUNNING rows identifiable
--    after a crash for bounded recovery.
--
-- No new tables or enums. Columns are nullable and additive.

ALTER TABLE "AiInvestigation" ADD COLUMN "executionClaimId" TEXT;
ALTER TABLE "AiInvestigation" ADD COLUMN "executionClaimedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "AiInvestigation_tenantId_storeId_exceptionId_running_key"
  ON "AiInvestigation"("tenantId", "storeId", "exceptionId")
  WHERE "status" = 'RUNNING';

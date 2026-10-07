-- CreateEnum
CREATE TYPE "AiInvestigationStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "AiDecisionBasis" AS ENUM ('TENANT_HISTORY', 'POOLED_PRIOR', 'HEURISTIC');

-- CreateEnum
CREATE TYPE "AiRiskTier" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "AiDecisionProposalStatus" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED', 'EXECUTED', 'EXECUTION_FAILED');

-- CreateEnum
CREATE TYPE "AiOutcome" AS ENUM ('APPROVED', 'REJECTED', 'EDITED');

-- CreateEnum
CREATE TYPE "AiAutonomyLevel" AS ENUM ('RECOMMEND_ONLY', 'AUTO_BELOW_THRESHOLD');

-- AlterEnum
ALTER TYPE "AuditActorType" ADD VALUE 'AI_AGENT';

-- CreateTable
CREATE TABLE "AiInvestigation" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "exceptionId" UUID NOT NULL,
    "status" "AiInvestigationStatus" NOT NULL DEFAULT 'RUNNING',
    "model" TEXT NOT NULL,
    "toolCallCount" INTEGER NOT NULL DEFAULT 0,
    "tokensUsed" INTEGER,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "AiInvestigation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiToolCall" (
    "id" UUID NOT NULL,
    "investigationId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "toolName" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "output" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiToolCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiDecisionProposal" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "exceptionId" UUID NOT NULL,
    "investigationId" UUID NOT NULL,
    "actionType" TEXT NOT NULL,
    "targetEntityType" TEXT NOT NULL,
    "targetEntityId" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "basis" "AiDecisionBasis" NOT NULL,
    "riskTier" "AiRiskTier" NOT NULL,
    "reasoningSummary" TEXT NOT NULL,
    "evidenceRefs" JSONB NOT NULL,
    "status" "AiDecisionProposalStatus" NOT NULL DEFAULT 'PROPOSED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,

    CONSTRAINT "AiDecisionProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiOutcomeFeedback" (
    "id" UUID NOT NULL,
    "proposalId" UUID NOT NULL,
    "outcome" "AiOutcome" NOT NULL,
    "actorId" TEXT,
    "note" TEXT,
    "observedResult" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiOutcomeFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiMemoryFact" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "fact" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "sourceInvestigationId" TEXT,
    "supersedesId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastConfirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiMemoryFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiAutonomyPolicy" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "actionType" TEXT NOT NULL,
    "autonomyLevel" "AiAutonomyLevel" NOT NULL DEFAULT 'RECOMMEND_ONLY',
    "confidenceThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.9,
    "maxActionsPerHour" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiAutonomyPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiInvestigation_tenantId_storeId_status_idx" ON "AiInvestigation"("tenantId", "storeId", "status");

-- CreateIndex
CREATE INDEX "AiInvestigation_exceptionId_idx" ON "AiInvestigation"("exceptionId");

-- CreateIndex
CREATE INDEX "AiToolCall_investigationId_sequence_idx" ON "AiToolCall"("investigationId", "sequence");

-- CreateIndex
CREATE INDEX "AiDecisionProposal_tenantId_storeId_status_idx" ON "AiDecisionProposal"("tenantId", "storeId", "status");

-- CreateIndex
CREATE INDEX "AiDecisionProposal_exceptionId_idx" ON "AiDecisionProposal"("exceptionId");

-- CreateIndex
CREATE INDEX "AiDecisionProposal_investigationId_idx" ON "AiDecisionProposal"("investigationId");

-- CreateIndex
CREATE INDEX "AiOutcomeFeedback_proposalId_idx" ON "AiOutcomeFeedback"("proposalId");

-- CreateIndex
CREATE UNIQUE INDEX "AiMemoryFact_supersedesId_key" ON "AiMemoryFact"("supersedesId");

-- CreateIndex
CREATE INDEX "AiMemoryFact_tenantId_category_idx" ON "AiMemoryFact"("tenantId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "AiAutonomyPolicy_tenantId_actionType_key" ON "AiAutonomyPolicy"("tenantId", "actionType");

-- AddForeignKey
ALTER TABLE "AiInvestigation" ADD CONSTRAINT "AiInvestigation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiInvestigation" ADD CONSTRAINT "AiInvestigation_exceptionId_fkey" FOREIGN KEY ("exceptionId") REFERENCES "OperationalException"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiToolCall" ADD CONSTRAINT "AiToolCall_investigationId_fkey" FOREIGN KEY ("investigationId") REFERENCES "AiInvestigation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiDecisionProposal" ADD CONSTRAINT "AiDecisionProposal_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiDecisionProposal" ADD CONSTRAINT "AiDecisionProposal_exceptionId_fkey" FOREIGN KEY ("exceptionId") REFERENCES "OperationalException"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiDecisionProposal" ADD CONSTRAINT "AiDecisionProposal_investigationId_fkey" FOREIGN KEY ("investigationId") REFERENCES "AiInvestigation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiOutcomeFeedback" ADD CONSTRAINT "AiOutcomeFeedback_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "AiDecisionProposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiMemoryFact" ADD CONSTRAINT "AiMemoryFact_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiMemoryFact" ADD CONSTRAINT "AiMemoryFact_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "AiMemoryFact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiAutonomyPolicy" ADD CONSTRAINT "AiAutonomyPolicy_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

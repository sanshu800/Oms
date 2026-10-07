-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "StorePlatform" AS ENUM ('SHOPIFY');

-- CreateEnum
CREATE TYPE "StoreConnectionStatus" AS ENUM ('PENDING', 'ACTIVE', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "WebhookStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "ExceptionStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "ExceptionSeverity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW');

-- CreateTable
CREATE TABLE "Tenant" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreConnection" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "platform" "StorePlatform" NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "status" "StoreConnectionStatus" NOT NULL DEFAULT 'PENDING',
    "encryptedAccessToken" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "installedAt" TIMESTAMP(3),
    "disconnectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "topic" TEXT NOT NULL,
    "shopifyEventId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "payloadSha256" TEXT NOT NULL,
    "status" "WebhookStatus" NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyOrderSnapshot" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "financialStatus" TEXT NOT NULL,
    "fulfillmentStatus" TEXT NOT NULL,
    "raw" JSONB NOT NULL,
    "createdAtShopify" TIMESTAMP(3) NOT NULL,
    "updatedAtShopify" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopifyOrderSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationalException" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "severity" "ExceptionSeverity" NOT NULL,
    "status" "ExceptionStatus" NOT NULL DEFAULT 'OPEN',
    "title" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "recommendedNextStep" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "OperationalException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "storeId" UUID,
    "action" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "metadata" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StoreConnection_shopDomain_key" ON "StoreConnection"("shopDomain");

-- CreateIndex
CREATE INDEX "StoreConnection_tenantId_status_idx" ON "StoreConnection"("tenantId", "status");

-- CreateIndex
CREATE INDEX "WebhookEvent_tenantId_storeId_status_receivedAt_idx" ON "WebhookEvent"("tenantId", "storeId", "status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_storeId_shopifyEventId_key" ON "WebhookEvent"("storeId", "shopifyEventId");

-- CreateIndex
CREATE INDEX "ShopifyOrderSnapshot_tenantId_storeId_fulfillmentStatus_idx" ON "ShopifyOrderSnapshot"("tenantId", "storeId", "fulfillmentStatus");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyOrderSnapshot_storeId_shopifyOrderId_key" ON "ShopifyOrderSnapshot"("storeId", "shopifyOrderId");

-- CreateIndex
CREATE INDEX "OperationalException_tenantId_storeId_status_severity_detec_idx" ON "OperationalException"("tenantId", "storeId", "status", "severity", "detectedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OperationalException_storeId_fingerprint_key" ON "OperationalException"("storeId", "fingerprint");

-- CreateIndex
CREATE INDEX "AuditEvent_tenantId_occurredAt_idx" ON "AuditEvent"("tenantId", "occurredAt");

-- AddForeignKey
ALTER TABLE "StoreConnection" ADD CONSTRAINT "StoreConnection_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "StoreConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyOrderSnapshot" ADD CONSTRAINT "ShopifyOrderSnapshot_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "StoreConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyOrderSnapshot" ADD CONSTRAINT "ShopifyOrderSnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationalException" ADD CONSTRAINT "OperationalException_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "StoreConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationalException" ADD CONSTRAINT "OperationalException_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;


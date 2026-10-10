-- Shipping-Provider Integration Foundation — Stage 2
--
-- Provider-neutral shipping boundary, deliberately separate from the WMS
-- boundary (20261009120000). Tenant-scoped shipping connections, an
-- idempotency anchor for outbound provider requests, and a durable
-- idempotent inbound event log. Shipment gains additive provider
-- bookkeeping columns; status transitions remain owned by
-- FulfillmentService and only verified carrier-handover evidence marks a
-- shipment in transit.

-- ============================================================
-- Enums
-- ============================================================

CREATE TYPE "ShippingProvider" AS ENUM ('FAKE', 'SHIPROCKET');

CREATE TYPE "ShippingRequestKind" AS ENUM ('SHIPMENT_CREATE', 'SHIPMENT_CANCEL');

CREATE TYPE "ShippingRequestStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- ============================================================
-- Shipment: additive provider bookkeeping columns
-- ============================================================

ALTER TABLE "Shipment"
  ADD COLUMN "awbCode" TEXT,
  ADD COLUMN "labelUrl" TEXT,
  ADD COLUMN "courierName" TEXT,
  ADD COLUMN "externalOrderId" TEXT,
  ADD COLUMN "handedOverAt" TIMESTAMP(3),
  ADD COLUMN "cancellationRequestedAt" TIMESTAMP(3),
  ADD COLUMN "cancellationRequestRef" TEXT,
  ADD COLUMN "lastProviderStatus" TEXT,
  ADD COLUMN "needsReconciliation" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "reconciliationReason" TEXT;

-- ============================================================
-- ShippingConnection
-- ============================================================

CREATE TABLE "ShippingConnection" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "provider" "ShippingProvider" NOT NULL,
  "externalAccountId" TEXT NOT NULL,
  "status" "StoreConnectionStatus" NOT NULL DEFAULT 'PENDING',
  "encryptedApiKey" TEXT,
  "encryptedWebhookSecret" TEXT,
  "connectedAt" TIMESTAMP(3),
  "disconnectedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ShippingConnection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShippingConnection_tenantId_provider_externalAccountId_key"
  ON "ShippingConnection"("tenantId", "provider", "externalAccountId");

CREATE INDEX "ShippingConnection_tenantId_status_idx"
  ON "ShippingConnection"("tenantId", "status");

ALTER TABLE "ShippingConnection"
  ADD CONSTRAINT "ShippingConnection_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- ShippingOutboundRequest
-- ============================================================

CREATE TABLE "ShippingOutboundRequest" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "storeId" UUID NOT NULL,
  "connectionId" UUID NOT NULL,
  "fulfillmentId" UUID NOT NULL,
  "shipmentId" UUID,
  "kind" "ShippingRequestKind" NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "status" "ShippingRequestStatus" NOT NULL DEFAULT 'PENDING',
  "externalRequestId" TEXT,
  "responseJson" JSONB,
  "lastError" TEXT,
  "succeededAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ShippingOutboundRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShippingOutboundRequest_connectionId_idempotencyKey_key"
  ON "ShippingOutboundRequest"("connectionId", "idempotencyKey");

CREATE UNIQUE INDEX "ShippingOutboundRequest_connectionId_externalRequestId_key"
  ON "ShippingOutboundRequest"("connectionId", "externalRequestId");

CREATE INDEX "ShippingOutboundRequest_tenantId_storeId_status_idx"
  ON "ShippingOutboundRequest"("tenantId", "storeId", "status");

CREATE INDEX "ShippingOutboundRequest_fulfillmentId_idx"
  ON "ShippingOutboundRequest"("fulfillmentId");

CREATE INDEX "ShippingOutboundRequest_shipmentId_idx"
  ON "ShippingOutboundRequest"("shipmentId");

ALTER TABLE "ShippingOutboundRequest"
  ADD CONSTRAINT "ShippingOutboundRequest_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ShippingOutboundRequest"
  ADD CONSTRAINT "ShippingOutboundRequest_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "StoreConnection"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ShippingOutboundRequest"
  ADD CONSTRAINT "ShippingOutboundRequest_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "ShippingConnection"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ShippingOutboundRequest"
  ADD CONSTRAINT "ShippingOutboundRequest_fulfillmentId_fkey"
  FOREIGN KEY ("fulfillmentId") REFERENCES "Fulfillment"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ShippingOutboundRequest"
  ADD CONSTRAINT "ShippingOutboundRequest_shipmentId_fkey"
  FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================
-- ShippingEvent
-- ============================================================

CREATE TABLE "ShippingEvent" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "connectionId" UUID NOT NULL,
  "shipmentId" UUID,
  "externalEventId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "payloadSha256" TEXT NOT NULL,
  "status" "WebhookStatus" NOT NULL DEFAULT 'RECEIVED',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "rejectionReason" TEXT,

  CONSTRAINT "ShippingEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShippingEvent_connectionId_externalEventId_key"
  ON "ShippingEvent"("connectionId", "externalEventId");

CREATE INDEX "ShippingEvent_tenantId_connectionId_status_receivedAt_idx"
  ON "ShippingEvent"("tenantId", "connectionId", "status", "receivedAt");

CREATE INDEX "ShippingEvent_shipmentId_idx"
  ON "ShippingEvent"("shipmentId");

ALTER TABLE "ShippingEvent"
  ADD CONSTRAINT "ShippingEvent_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ShippingEvent"
  ADD CONSTRAINT "ShippingEvent_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "ShippingConnection"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ShippingEvent"
  ADD CONSTRAINT "ShippingEvent_shipmentId_fkey"
  FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================
-- Row-Level Security (matches 20260822161416 conventions)
-- ============================================================

ALTER TABLE "ShippingConnection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ShippingConnection" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ShippingConnection"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true));

ALTER TABLE "ShippingOutboundRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ShippingOutboundRequest" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ShippingOutboundRequest"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true));

ALTER TABLE "ShippingEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ShippingEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ShippingEvent"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true));

-- WMS Integration Foundation — Stage 1
--
-- Provider-neutral warehouse integration boundary: tenant-scoped WMS
-- connection configuration, idempotent outbound fulfillment requests,
-- and a durable/idempotent inbound event log. Warehouse execution state
-- is tracked separately from shipping-provider (Shipment) state.

-- ============================================================
-- Enums
-- ============================================================

CREATE TYPE "WmsProvider" AS ENUM ('FAKE');

CREATE TYPE "WmsRequestStatus" AS ENUM (
  'PENDING',
  'SUBMITTED',
  'ACKNOWLEDGED',
  'COMPLETED',
  'FAILED',
  'CANCELLED'
);

-- ============================================================
-- WmsConnection
-- ============================================================

CREATE TABLE "WmsConnection" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "provider" "WmsProvider" NOT NULL,
  "externalWarehouseId" TEXT NOT NULL,
  "locationId" UUID NOT NULL,
  "status" "StoreConnectionStatus" NOT NULL DEFAULT 'PENDING',
  "encryptedApiKey" TEXT,
  "encryptedWebhookSecret" TEXT,
  "connectedAt" TIMESTAMP(3),
  "disconnectedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WmsConnection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WmsConnection_tenantId_provider_externalWarehouseId_key"
  ON "WmsConnection"("tenantId", "provider", "externalWarehouseId");

CREATE INDEX "WmsConnection_tenantId_status_idx"
  ON "WmsConnection"("tenantId", "status");

ALTER TABLE "WmsConnection"
  ADD CONSTRAINT "WmsConnection_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WmsConnection"
  ADD CONSTRAINT "WmsConnection_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "InventoryLocation"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================
-- WmsFulfillmentRequest
-- ============================================================

CREATE TABLE "WmsFulfillmentRequest" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "storeId" UUID NOT NULL,
  "connectionId" UUID NOT NULL,
  "fulfillmentId" UUID NOT NULL,
  "externalRequestId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "status" "WmsRequestStatus" NOT NULL DEFAULT 'PENDING',
  "lastError" TEXT,
  "submittedAt" TIMESTAMP(3),
  "acknowledgedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WmsFulfillmentRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WmsFulfillmentRequest_connectionId_idempotencyKey_key"
  ON "WmsFulfillmentRequest"("connectionId", "idempotencyKey");

CREATE UNIQUE INDEX "WmsFulfillmentRequest_connectionId_externalRequestId_key"
  ON "WmsFulfillmentRequest"("connectionId", "externalRequestId");

CREATE INDEX "WmsFulfillmentRequest_tenantId_storeId_status_idx"
  ON "WmsFulfillmentRequest"("tenantId", "storeId", "status");

CREATE INDEX "WmsFulfillmentRequest_fulfillmentId_idx"
  ON "WmsFulfillmentRequest"("fulfillmentId");

ALTER TABLE "WmsFulfillmentRequest"
  ADD CONSTRAINT "WmsFulfillmentRequest_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WmsFulfillmentRequest"
  ADD CONSTRAINT "WmsFulfillmentRequest_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "StoreConnection"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WmsFulfillmentRequest"
  ADD CONSTRAINT "WmsFulfillmentRequest_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "WmsConnection"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WmsFulfillmentRequest"
  ADD CONSTRAINT "WmsFulfillmentRequest_fulfillmentId_fkey"
  FOREIGN KEY ("fulfillmentId") REFERENCES "Fulfillment"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- WmsFulfillmentRequestLine
-- ============================================================

CREATE TABLE "WmsFulfillmentRequestLine" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "requestId" UUID NOT NULL,
  "orderItemId" UUID NOT NULL,
  "externalLineRef" TEXT NOT NULL,
  "sku" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "pickedQuantity" INTEGER NOT NULL DEFAULT 0,
  "packedQuantity" INTEGER NOT NULL DEFAULT 0,
  "shippedQuantity" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WmsFulfillmentRequestLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WmsFulfillmentRequestLine_requestId_orderItemId_key"
  ON "WmsFulfillmentRequestLine"("requestId", "orderItemId");

CREATE UNIQUE INDEX "WmsFulfillmentRequestLine_requestId_externalLineRef_key"
  ON "WmsFulfillmentRequestLine"("requestId", "externalLineRef");

CREATE INDEX "WmsFulfillmentRequestLine_orderItemId_idx"
  ON "WmsFulfillmentRequestLine"("orderItemId");

ALTER TABLE "WmsFulfillmentRequestLine"
  ADD CONSTRAINT "WmsFulfillmentRequestLine_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "WmsFulfillmentRequest"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WmsFulfillmentRequestLine"
  ADD CONSTRAINT "WmsFulfillmentRequestLine_orderItemId_fkey"
  FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================
-- WmsEvent
-- ============================================================

CREATE TABLE "WmsEvent" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "connectionId" UUID NOT NULL,
  "requestId" UUID,
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

  CONSTRAINT "WmsEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WmsEvent_connectionId_externalEventId_key"
  ON "WmsEvent"("connectionId", "externalEventId");

CREATE INDEX "WmsEvent_tenantId_connectionId_status_receivedAt_idx"
  ON "WmsEvent"("tenantId", "connectionId", "status", "receivedAt");

ALTER TABLE "WmsEvent"
  ADD CONSTRAINT "WmsEvent_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WmsEvent"
  ADD CONSTRAINT "WmsEvent_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "WmsConnection"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WmsEvent"
  ADD CONSTRAINT "WmsEvent_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "WmsFulfillmentRequest"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================
-- Row-Level Security (matches 20260822161416 conventions)
-- ============================================================

ALTER TABLE "WmsConnection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WmsConnection" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "WmsConnection"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true));

ALTER TABLE "WmsFulfillmentRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WmsFulfillmentRequest" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "WmsFulfillmentRequest"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true));

ALTER TABLE "WmsEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WmsEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "WmsEvent"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true));

-- Child table without its own tenantId: scope through the parent request.
ALTER TABLE "WmsFulfillmentRequestLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WmsFulfillmentRequestLine" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "WmsFulfillmentRequestLine"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR EXISTS (
      SELECT 1 FROM "WmsFulfillmentRequest" r
      WHERE r.id = "WmsFulfillmentRequestLine"."requestId"
        AND r."tenantId"::text = current_setting('app.tenant_id', true)
    )
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR EXISTS (
      SELECT 1 FROM "WmsFulfillmentRequest" r
      WHERE r.id = "WmsFulfillmentRequestLine"."requestId"
        AND r."tenantId"::text = current_setting('app.tenant_id', true)
    )
  );

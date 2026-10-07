-- Row-Level Security: database-level tenant isolation, independent of
-- whether every application query remembers to filter by tenantId.
--
-- Two session variables drive every policy:
--   app.tenant_id   — the authenticated tenant for this connection/transaction.
--   app.bypass_rls  — set to 'on' only for the small number of legitimately
--                     cross-tenant/pre-tenant operations (resolving a store by
--                     shop domain during webhook/OAuth handling, tenant
--                     provisioning itself, and admin/dev tooling). Everything
--                     else is denied by default — an application bug that
--                     forgets a tenantId filter now fails closed, not open.
--
-- FORCE ROW LEVEL SECURITY is required on every table: by default Postgres
-- lets the owning role bypass RLS entirely, and our app connects as the
-- table-owning role. Without FORCE, these policies would silently do nothing.

-- ============================================================
-- Tables with a direct tenantId column
-- ============================================================

ALTER TABLE "StoreConnection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StoreConnection" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "StoreConnection"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true));

ALTER TABLE "WebhookEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WebhookEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "WebhookEvent"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true));

ALTER TABLE "ShopifyOrderSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ShopifyOrderSnapshot" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ShopifyOrderSnapshot"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true));

ALTER TABLE "Order" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Order" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Order"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true));

ALTER TABLE "InventoryItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InventoryItem" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "InventoryItem"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true));

ALTER TABLE "InventoryLocation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InventoryLocation" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "InventoryLocation"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true));

ALTER TABLE "InventoryReservation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InventoryReservation" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "InventoryReservation"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true));

ALTER TABLE "InventoryMovement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InventoryMovement" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "InventoryMovement"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true));

ALTER TABLE "Fulfillment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Fulfillment" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Fulfillment"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true));

ALTER TABLE "Shipment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Shipment" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Shipment"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true));

ALTER TABLE "InventoryItemExternalReference" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InventoryItemExternalReference" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "InventoryItemExternalReference"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true));

ALTER TABLE "InventoryLocationExternalReference" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InventoryLocationExternalReference" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "InventoryLocationExternalReference"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true));

ALTER TABLE "OperationalException" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OperationalException" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "OperationalException"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true));

ALTER TABLE "AuditEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AuditEvent"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true));

ALTER TABLE "AiInvestigation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiInvestigation" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AiInvestigation"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true));

ALTER TABLE "AiDecisionProposal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiDecisionProposal" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AiDecisionProposal"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true));

ALTER TABLE "AiMemoryFact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiMemoryFact" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AiMemoryFact"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true));

ALTER TABLE "AiAutonomyPolicy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiAutonomyPolicy" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AiAutonomyPolicy"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true));

ALTER TABLE "TenantApiKey" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenantApiKey" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "TenantApiKey"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId"::text = current_setting('app.tenant_id', true));

-- ============================================================
-- Tables scoped only through a parent relation (no tenantId column
-- of their own) — the policy checks the parent row's tenantId instead.
-- ============================================================

ALTER TABLE "OrderItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrderItem" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "OrderItem"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR EXISTS (
      SELECT 1 FROM "Order" o
      WHERE o.id = "OrderItem"."orderId"
        AND o."tenantId"::text = current_setting('app.tenant_id', true)
    )
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR EXISTS (
      SELECT 1 FROM "Order" o
      WHERE o.id = "OrderItem"."orderId"
        AND o."tenantId"::text = current_setting('app.tenant_id', true)
    )
  );

ALTER TABLE "InventoryBalance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InventoryBalance" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "InventoryBalance"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR EXISTS (
      SELECT 1 FROM "InventoryItem" ii
      WHERE ii.id = "InventoryBalance"."inventoryItemId"
        AND ii."tenantId"::text = current_setting('app.tenant_id', true)
    )
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR EXISTS (
      SELECT 1 FROM "InventoryItem" ii
      WHERE ii.id = "InventoryBalance"."inventoryItemId"
        AND ii."tenantId"::text = current_setting('app.tenant_id', true)
    )
  );

ALTER TABLE "FulfillmentItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FulfillmentItem" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "FulfillmentItem"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR EXISTS (
      SELECT 1 FROM "Fulfillment" f
      WHERE f.id = "FulfillmentItem"."fulfillmentId"
        AND f."tenantId"::text = current_setting('app.tenant_id', true)
    )
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR EXISTS (
      SELECT 1 FROM "Fulfillment" f
      WHERE f.id = "FulfillmentItem"."fulfillmentId"
        AND f."tenantId"::text = current_setting('app.tenant_id', true)
    )
  );

ALTER TABLE "ShipmentItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ShipmentItem" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ShipmentItem"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR EXISTS (
      SELECT 1 FROM "Shipment" s
      WHERE s.id = "ShipmentItem"."shipmentId"
        AND s."tenantId"::text = current_setting('app.tenant_id', true)
    )
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR EXISTS (
      SELECT 1 FROM "Shipment" s
      WHERE s.id = "ShipmentItem"."shipmentId"
        AND s."tenantId"::text = current_setting('app.tenant_id', true)
    )
  );

ALTER TABLE "AiToolCall" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiToolCall" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AiToolCall"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR EXISTS (
      SELECT 1 FROM "AiInvestigation" ai
      WHERE ai.id = "AiToolCall"."investigationId"
        AND ai."tenantId"::text = current_setting('app.tenant_id', true)
    )
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR EXISTS (
      SELECT 1 FROM "AiInvestigation" ai
      WHERE ai.id = "AiToolCall"."investigationId"
        AND ai."tenantId"::text = current_setting('app.tenant_id', true)
    )
  );

ALTER TABLE "AiOutcomeFeedback" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiOutcomeFeedback" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AiOutcomeFeedback"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR EXISTS (
      SELECT 1 FROM "AiDecisionProposal" p
      WHERE p.id = "AiOutcomeFeedback"."proposalId"
        AND p."tenantId"::text = current_setting('app.tenant_id', true)
    )
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR EXISTS (
      SELECT 1 FROM "AiDecisionProposal" p
      WHERE p.id = "AiOutcomeFeedback"."proposalId"
        AND p."tenantId"::text = current_setting('app.tenant_id', true)
    )
  );

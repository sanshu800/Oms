-- Connector-boundary refactor: neutral channel identities and the
-- canonical mapping column. See docs/AUDIT.md decisions 4-6.
--
-- 1. WebhookEvent (decision 6): the delivery id is channel-neutral.
ALTER TABLE "WebhookEvent" RENAME COLUMN "shopifyEventId" TO "externalEventId";
ALTER INDEX "WebhookEvent_storeId_shopifyEventId_key" RENAME TO "WebhookEvent_storeId_externalEventId_key";

-- 2. StoreConnection (decision 5): externalStoreId becomes the single
--    neutral external store identity. The old placeholder externalStoreId
--    column is dropped (only ad-hoc dev scripts wrote it, with internal
--    ids); the unique shopDomain column becomes externalStoreId, uniquely
--    identified per platform. For Shopify the value is the shop domain,
--    which is what webhook deliveries and OAuth flows name.
ALTER TABLE "StoreConnection" DROP COLUMN "externalStoreId";
ALTER TABLE "StoreConnection" RENAME COLUMN "shopDomain" TO "externalStoreId";
ALTER TABLE "StoreConnection" DROP CONSTRAINT "StoreConnection_shopDomain_key";
ALTER TABLE "StoreConnection" ADD CONSTRAINT "StoreConnection_platform_externalStoreId_key" UNIQUE ("platform", "externalStoreId");

-- 3. OrderItem (decision 4): carries the channel catalog-item reference
--    used as the primary key for canonical inventory resolution via
--    InventoryItemExternalReference.
ALTER TABLE "OrderItem" ADD COLUMN "externalItemRef" TEXT;

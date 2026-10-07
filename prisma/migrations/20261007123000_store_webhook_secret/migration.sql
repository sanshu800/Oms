-- Per-store webhook signing secret.
--
-- Webhook HMACs were verified against a single deployment-wide
-- SHOPIFY_WEBHOOK_SECRET. That is correct for an OAuth app, where one app
-- secret signs deliveries for every store that installs it. It is wrong for
-- admin-created custom apps: each one has its own API secret key, so the
-- second store connected this way has every delivery rejected with 401 —
-- and Shopify deletes a subscription that keeps failing, so the visible
-- symptom is "we quietly stopped receiving orders".
--
-- Null keeps the environment fallback, so existing connections (and OAuth
-- installs) behave exactly as before.
ALTER TABLE "StoreConnection"
  ADD COLUMN "encryptedWebhookSecret" TEXT;

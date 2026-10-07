require("dotenv").config();

const crypto = require("crypto");

const now = new Date().toISOString();

const payload = {
  id: Date.now(),

  name: `#INV-${Date.now()}`,

  financial_status: "paid",

  fulfillment_status: null,

  total_price: "1499.00",

  currency: "INR",

  created_at: now,

  updated_at: now,

  line_items: [
    {
      id: Date.now() + 1,
      sku: "TEST-SKU-001",
      title: "Test Product",
      quantity: 2,
      price: "749.50",
      variant_id: 555001,
    },
  ],
};

const rawBody = JSON.stringify(payload);

const secret =
  process.env.SHOPIFY_WEBHOOK_SECRET;

if (!secret) {
  console.error(
    "SHOPIFY_WEBHOOK_SECRET is not configured",
  );

  process.exit(1);
}

const signature = crypto
  .createHmac("sha256", secret)
  .update(Buffer.from(rawBody))
  .digest("base64");

const webhookId =
  "local-inventory-test-" + Date.now();

async function main() {
  const response = await fetch(
    "http://localhost:4000/webhooks/shopify",
    {
      method: "POST",

      headers: {
        "content-type": "application/json",

        "x-shopify-hmac-sha256":
          signature,

        "x-shopify-shop-domain":
          "test.myshopify.com",

        "x-shopify-webhook-id":
          webhookId,

        "x-shopify-topic":
          "orders/create",
      },

      body: rawBody,
    },
  );

  console.log(
    "HTTP:",
    response.status,
  );

  console.log(
    "Response:",
    await response.text(),
  );

  console.log(
    "Webhook ID:",
    webhookId,
  );

  console.log(
    "Shopify Order ID:",
    payload.id,
  );

  console.log(
    "SKU:",
    payload.line_items[0].sku,
  );

  console.log(
    "Quantity:",
    payload.line_items[0].quantity,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
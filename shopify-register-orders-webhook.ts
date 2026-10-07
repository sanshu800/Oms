import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { decryptSecret } from "./src/shopify/shopify-auth.crypto";

const prisma = new PrismaClient();

async function main() {
  const shopDomain = "techmart-lab.myshopify.com";
  const appUrl = process.env.APP_URL?.replace(/\/+$/, "");
  const encryptionKey = process.env.ENCRYPTION_KEY;

  if (!appUrl) throw new Error("APP_URL is not configured");
  if (!encryptionKey) throw new Error("ENCRYPTION_KEY is not configured");

  const webhookUri = `${appUrl}/webhooks/shopify`;

  const store = await prisma.storeConnection.findUnique({
    where: { shopDomain },
    select: {
      shopDomain: true,
      status: true,
      encryptedAccessToken: true,
      scopes: true,
    },
  });

  if (!store) throw new Error(`Store not found: ${shopDomain}`);
  if (!store.encryptedAccessToken) {
    throw new Error("Encrypted Shopify access token is missing");
  }

  const accessToken = decryptSecret(
    store.encryptedAccessToken,
    encryptionKey,
  );

  const query = `
    mutation webhookSubscriptionCreate(
      $topic: WebhookSubscriptionTopic!
      $webhookSubscription: WebhookSubscriptionInput!
    ) {
      webhookSubscriptionCreate(
        topic: $topic
        webhookSubscription: $webhookSubscription
      ) {
        webhookSubscription {
          id
          topic
          uri
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const response = await fetch(
    `https://${shopDomain}/admin/api/2026-07/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        query,
        variables: {
          topic: "ORDERS_CREATE",
          webhookSubscription: {
            uri: webhookUri,
          },
        },
      }),
    },
  );

  const result = await response.json();

  console.log(
    JSON.stringify(
      {
        httpStatus: response.status,
        shopDomain,
        webhookUri,
        scopes: store.scopes,
        result,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(
      error instanceof Error ? error.message : error,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

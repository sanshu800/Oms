import { NestFactory } from "@nestjs/core";
import { AppModule } from "./src/app.module";
import { PrismaService } from "./src/prisma/prisma.service";
import { ConfigService } from "@nestjs/config";
import { decryptSecret } from "./src/shopify/shopify-auth.crypto";

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule);

  try {
    const prisma = app.get(PrismaService);
    const config = app.get(ConfigService);

    const store = await prisma.storeConnection.findUnique({
      where: {
        platform_externalStoreId: {
          platform: "SHOPIFY",
          externalStoreId: "techmart-lab.myshopify.com",
        },
      },
      select: {
        id: true,
        externalStoreId: true,
        encryptedAccessToken: true,
      },
    });

    if (!store) {
      throw new Error("Shopify store not found");
    }

    if (!store.encryptedAccessToken) {
      throw new Error("Encrypted Shopify access token not found");
    }

    const encryptionKey = config.get<string>("ENCRYPTION_KEY");

    if (!encryptionKey) {
      throw new Error("ENCRYPTION_KEY is not configured");
    }

    const accessToken = decryptSecret(
      store.encryptedAccessToken,
      encryptionKey,
    );

    const query = `
      query ShopifyOrderInspection {
        orders(first: 5, query: "name:#1001") {
          nodes {
            id
            name
            createdAt
            updatedAt
            displayFinancialStatus
            displayFulfillmentStatus

            currentTotalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }

            lineItems(first: 20) {
              nodes {
                id
                title
                quantity
                sku

                originalUnitPriceSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
        }
      }
    `;

    const response = await fetch(
      `https://${store.externalStoreId}/admin/api/2026-07/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query }),
      },
    );

    const result = await response.json();

    if (!response.ok) {
      throw new Error(
        `Shopify HTTP error: ${response.status}`,
      );
    }

    if (result.errors?.length) {
      throw new Error(
        `Shopify GraphQL error: ${result.errors
          .map((error: { message: string }) => error.message)
          .join("; ")}`,
      );
    }

    console.log(
      JSON.stringify(
        {
          shopDomain: store.externalStoreId,
          result,
        },
        null,
        2,
      ),
    );
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error("SHOPIFY ORDER INSPECTION FAILED");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

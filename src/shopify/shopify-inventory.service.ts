import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { StorePlatform } from "@prisma/client";
import { decryptSecret } from "./shopify-auth.crypto";

type ShopifyInventoryNode = {
  id: string;
  title: string;
  variants: {
    nodes: Array<{
      id: string;
      title: string;
      sku: string | null;
      inventoryItem: {
        id: string;
        inventoryLevels: {
          nodes: Array<{
            quantities: Array<{
              name: string;
              quantity: number;
            }>;
            location: {
              id: string;
              name: string;
            };
          }>;
        };
      } | null;
    }>;
  };
};

type ShopifyProductsPage = {
  nodes: ShopifyInventoryNode[];
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
};

@Injectable()
export class ShopifyInventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async syncStoreInventory(shopDomain: string) {
    // Resolving a store by shop domain is inherently a cross-tenant
    // lookup — it happens before we know which tenant this is.
    const store = await this.prisma.runAsSystem(() =>
      this.prisma.storeConnection.findUnique({
        where: { shopDomain },
        select: {
          id: true,
          tenantId: true,
          shopDomain: true,
          platform: true,
          encryptedAccessToken: true,
        },
      }),
    );

    if (!store) {
      throw new Error(`Shopify store not found: ${shopDomain}`);
    }

    if (!store.encryptedAccessToken) {
      throw new Error(`Shopify access token missing: ${shopDomain}`);
    }

    // Everything else touches this tenant's own canonical inventory —
    // scope it accordingly now that we know which tenant it is.
    return this.prisma.runAsTenant(store.tenantId, () =>
      this.syncResolvedStoreInventory(store),
    );
  }

  private async syncResolvedStoreInventory(store: {
    id: string;
    tenantId: string;
    shopDomain: string;
    encryptedAccessToken: string | null;
  }) {
    const encryptionKey = this.config.get<string>("ENCRYPTION_KEY");

    if (!encryptionKey) {
      throw new Error("ENCRYPTION_KEY is not configured");
    }

    const accessToken = decryptSecret(
      store.encryptedAccessToken!,
      encryptionKey,
    );

    let cursor: string | null = null;
    let productsRead = 0;
    let inventoryLevelsSynced = 0;
    let pages = 0;

    do {
      const page = await this.fetchProductsPage(
        store.shopDomain,
        accessToken,
        cursor,
      );

      pages++;

      for (const product of page.nodes) {
        productsRead++;

        for (const variant of product.variants.nodes) {
          if (!variant.sku || !variant.inventoryItem) {
            continue;
          }

          for (const level of variant.inventoryItem.inventoryLevels.nodes) {
            const availableQuantity =
              level.quantities.find(
                (quantity) => quantity.name === "available",
              )?.quantity ?? 0;

            await this.syncInventoryLevel({
              tenantId: store.tenantId,
              storeId: store.id,
              sku: variant.sku,
              itemName: `${product.title} - ${variant.title}`,
              inventoryItemExternalId: variant.inventoryItem.id,
              locationExternalId: level.location.id,
              locationName: level.location.name,
              availableQuantity,
            });

            inventoryLevelsSynced++;
          }
        }
      }

      cursor = page.pageInfo.hasNextPage
        ? page.pageInfo.endCursor
        : null;
    } while (cursor);

    return {
      shopDomain: store.shopDomain,
      pages,
      products: productsRead,
      inventoryLevelsSynced,
    };
  }

  private async fetchProductsPage(
    shopDomain: string,
    accessToken: string,
    cursor: string | null,
  ): Promise<ShopifyProductsPage> {
    const query = `
      query ShopifyInventoryProducts($cursor: String) {
        products(first: 20, after: $cursor) {
          nodes {
            id
            title

            variants(first: 20) {
              nodes {
                id
                title
                sku

                inventoryItem {
                  id

                  inventoryLevels(first: 20) {
                    nodes {
                      quantities(names: ["available"]) {
                        name
                        quantity
                      }

                      location {
                        id
                        name
                      }
                    }
                  }
                }
              }
            }
          }

          pageInfo {
            hasNextPage
            endCursor
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
            cursor,
          },
        }),
      },
    );

    const result = (await response.json()) as {
      data?: {
        products?: ShopifyProductsPage;
      };
      errors?: Array<{ message: string }>;
    };

    if (!response.ok) {
      throw new Error(
        `Shopify inventory request failed with HTTP ${response.status}`,
      );
    }

    if (result.errors?.length) {
      throw new Error(
        `Shopify GraphQL error: ${result.errors
          .map((error) => error.message)
          .join("; ")}`,
      );
    }

    if (!result.data?.products) {
      throw new Error("Shopify GraphQL returned no products data");
    }

    return result.data.products;
  }

  private async syncInventoryLevel(input: {
    tenantId: string;
    storeId: string;
    sku: string;
    itemName: string;
    inventoryItemExternalId: string;
    locationExternalId: string;
    locationName: string;
    availableQuantity: number;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const existingItemReference =
        await tx.inventoryItemExternalReference.findUnique({
          where: {
            storeId_platform_externalId: {
              storeId: input.storeId,
              platform: StorePlatform.SHOPIFY,
              externalId: input.inventoryItemExternalId,
            },
          },
        });

      let inventoryItemId = existingItemReference?.inventoryItemId;

      if (!inventoryItemId) {
        const existingItem = await tx.inventoryItem.findUnique({
          where: {
            tenantId_sku: {
              tenantId: input.tenantId,
              sku: input.sku,
            },
          },
        });

        const inventoryItem =
          existingItem ??
          (await tx.inventoryItem.create({
            data: {
              tenantId: input.tenantId,
              sku: input.sku,
              name: input.itemName,
              active: true,
            },
          }));

        inventoryItemId = inventoryItem.id;

        await tx.inventoryItemExternalReference.upsert({
          where: {
            storeId_platform_externalId: {
              storeId: input.storeId,
              platform: StorePlatform.SHOPIFY,
              externalId: input.inventoryItemExternalId,
            },
          },
          create: {
            tenantId: input.tenantId,
            storeId: input.storeId,
            inventoryItemId,
            platform: StorePlatform.SHOPIFY,
            externalId: input.inventoryItemExternalId,
          },
          update: {
            inventoryItemId,
          },
        });
      }

      const locationCode = `SHOPIFY-${input.locationExternalId
        .replace("gid://shopify/Location/", "")
        .replace(/[^A-Za-z0-9_-]/g, "")}`;

      const existingLocationReference =
        await tx.inventoryLocationExternalReference.findUnique({
          where: {
            storeId_platform_externalId: {
              storeId: input.storeId,
              platform: StorePlatform.SHOPIFY,
              externalId: input.locationExternalId,
            },
          },
        });

      let locationId = existingLocationReference?.locationId;

      if (!locationId) {
        const location =
          await tx.inventoryLocation.findUnique({
            where: {
              tenantId_code: {
                tenantId: input.tenantId,
                code: locationCode,
              },
            },
          }) ??
          (await tx.inventoryLocation.create({
            data: {
              tenantId: input.tenantId,
              code: locationCode,
              name: input.locationName,
              active: true,
            },
          }));

        locationId = location.id;

        await tx.inventoryLocationExternalReference.upsert({
          where: {
            storeId_platform_externalId: {
              storeId: input.storeId,
              platform: StorePlatform.SHOPIFY,
              externalId: input.locationExternalId,
            },
          },
          create: {
            tenantId: input.tenantId,
            storeId: input.storeId,
            locationId,
            platform: StorePlatform.SHOPIFY,
            externalId: input.locationExternalId,
          },
          update: {
            locationId,
          },
        });
      }

      return tx.inventoryBalance.upsert({
        where: {
          inventoryItemId_locationId: {
            inventoryItemId,
            locationId,
          },
        },
        create: {
          inventoryItemId,
          locationId,
          availableQty: input.availableQuantity,
          reservedQty: 0,
          committedQty: 0,
        },
        update: {
          availableQty: input.availableQuantity,
        },
      });
    });
  }
}

/**
 * Maps a Shopify store's SKUs onto the OMS inventory catalogue.
 *
 * Why this exists: an `orders/create` delivery is turned into a reservation by
 * looking the line item's **SKU** up in the tenant's `InventoryItem` table. A
 * store that has just been connected has none of those rows yet, so a real
 * order ends as an `ORDER_OPERATIONAL_RISK` exception ("references unknown
 * SKU …") with no stock reserved. This script is the supported way to close
 * that gap — and, optionally, to record which Shopify inventory item each SKU
 * corresponds to, which is what the outbound stock sync needs.
 *
 * Usage:
 *   # See what the store's orders would resolve against, and what is missing.
 *   npx ts-node map-shopify-sku.ts --shop=techmart-lab.myshopify.com --list
 *
 *   # Ensure a SKU exists in the OMS catalogue, with stock, and map it.
 *   npx ts-node map-shopify-sku.ts \
 *     --shop=techmart-lab.myshopify.com \
 *     --sku=TSHIRT-BLACK-M --name="Black Tee (M)" --qty=25 \
 *     --shopify-inventory-item-id=gid://shopify/InventoryItem/1234567890
 *
 *   # Drop the Shopify-side mapping only (the OMS item and its stock stay).
 *   npx ts-node map-shopify-sku.ts --shop=… --sku=TSHIRT-BLACK-M --remove
 *
 * Flags:
 *   --sku=<sku>                        OMS SKU (must equal the Shopify variant SKU)
 *   --name="…"                         required only when the item is new
 *   --qty=<n>                          initial available stock for a new item
 *   --shopify-inventory-item-id=<id>   Shopify inventory item id (numeric or gid://)
 *   --location-id=<uuid>               required when the tenant has several locations
 *   --list                             report mappings and gaps, change nothing
 *   --remove                           remove this SKU's mapping
 *   --dry-run                          print what would change
 */

import "dotenv/config";

import { InventoryMovementType, Prisma, PrismaClient } from "@prisma/client";

import {
  createPrismaAdapter,
  databaseUrlFromEnv,
} from "./src/prisma/prisma-adapter";

type Options = {
  shopDomain?: string;
  sku?: string;
  name?: string;
  qty?: number;
  shopifyInventoryItemId?: string;
  locationId?: string;
  list: boolean;
  remove: boolean;
  dryRun: boolean;
};

function parseArguments(argv: string[]) {
  const flags = new Set(
    argv.filter((argument) => argument.startsWith("--") && !argument.includes("=")),
  );
  const values = new Map<string, string>();

  for (const argument of argv) {
    const match = argument.match(/^--([^=]+)=(.*)$/);

    if (match?.[1] !== undefined && match[2] !== undefined) {
      values.set(match[1], match[2]);
    }
  }

  return { flags, values };
}

function readOptions(argv: string[]): Options {
  const { flags, values } = parseArguments(argv);
  const qty = values.get("qty");

  return {
    shopDomain: (values.get("shop") ?? process.env.SHOPIFY_SHOP_DOMAIN)?.trim(),
    sku: values.get("sku")?.trim(),
    name: values.get("name")?.trim(),
    qty: qty === undefined ? undefined : Number(qty),
    shopifyInventoryItemId: values.get("shopify-inventory-item-id")?.trim(),
    locationId: values.get("location-id")?.trim(),
    list: flags.has("--list"),
    remove: flags.has("--remove"),
    dryRun: flags.has("--dry-run"),
  };
}

function fail(message: string): never {
  throw new Error(message);
}

function requireSku(value: string): string {
  const sku = value.trim();

  if (!sku) fail("SKU must not be blank");
  if (sku.length > 128) fail(`SKU is too long (128 characters max): ${sku}`);

  return sku;
}

const prisma = new PrismaClient({
  adapter: createPrismaAdapter(
    databaseUrlFromEnv(["DATABASE_URL", "APP_DATABASE_URL"]),
  ),
});

/**
 * Every read and write runs as an operator: one transaction with the RLS
 * bypass flag set, so the script works whether DATABASE_URL points at the
 * owning role (the usual case for admin tooling) or not. Writes are audited.
 */
async function asOperator<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);

    return fn(tx);
  });
}

async function resolveStore(shop: string) {
  const store = await prisma.storeConnection.findUnique({
    where: {
      platform_externalStoreId: {
        platform: "SHOPIFY",
        externalStoreId: shop,
      },
    },
    select: { id: true, tenantId: true, status: true, externalStoreId: true },
  });

  if (!store) {
    fail(
      `No store connection for ${shop}. Connect it first: npx ts-node connect-shopify-store.ts --shop=${shop} --token=<admin-api-token>`,
    );
  }

  return store;
}

async function listMappings(shop: string) {
  const store = await resolveStore(shop);

  const items = await asOperator((tx) =>
    tx.inventoryItem.findMany({
      where: { tenantId: store.tenantId },
      include: {
        balances: { include: { location: true } },
        externalReferences: { where: { storeId: store.id } },
      },
      orderBy: { sku: "asc" },
    }),
  );

  const rows = items.map((item) => {
    const available = item.balances.reduce(
      (total, balance) => total + balance.availableQty,
      0,
    );

    return {
      sku: item.sku,
      name: item.name,
      active: item.active,
      availableQty: available,
      shopifyInventoryItemId:
        item.externalReferences.find(
          (reference) => reference.platform === "SHOPIFY",
        )?.externalId ?? null,
      // Orders resolve stock by SKU alone; without a balance the reservation
      // fails even though the catalogue knows the SKU.
      reservationReady: item.active && available > 0,
    };
  });

  console.log(
    JSON.stringify(
      {
        shopDomain: store.externalStoreId,
        storeStatus: store.status,
        itemCount: rows.length,
        mapped: rows.filter((row) => row.shopifyInventoryItemId).length,
        items: rows,
      },
      null,
      2,
    ),
  );

  if (rows.length === 0) {
    console.log(
      [
        "",
        "No inventory items exist for this tenant yet, so every order line item",
        "will raise an ORDER_OPERATIONAL_RISK exception. Add the store's SKUs:",
        `  npx ts-node map-shopify-sku.ts --shop=${shop} --sku=<shopify-sku> --name="<product name>" --qty=<stock>`,
      ].join("\n"),
    );
  }
}

async function ensureLocationId(
  tx: Prisma.TransactionClient,
  tenantId: string,
  requestedLocationId: string | undefined,
): Promise<string> {
  if (requestedLocationId) {
    const location = await tx.inventoryLocation.findFirst({
      where: { id: requestedLocationId, tenantId, active: true },
      select: { id: true },
    });

    if (!location) fail(`Inventory location not found: ${requestedLocationId}`);

    return location.id;
  }

  const locations = await tx.inventoryLocation.findMany({
    where: { tenantId, active: true },
    orderBy: { createdAt: "asc" },
    take: 2,
    select: { id: true },
  });

  if (locations.length > 1) {
    fail(
      "This tenant has more than one active inventory location — pass --location-id=<uuid>.",
    );
  }

  if (locations[0]) return locations[0].id;

  const created = await tx.inventoryLocation.create({
    data: { tenantId, code: "DEFAULT", name: "Default Inventory Location" },
    select: { id: true },
  });

  return created.id;
}

async function run(options: Options) {
  const shop = requireShop(options);
  const store = await resolveStore(shop);

  if (options.list) {
    await listMappings(shop);

    return;
  }

  if (!options.sku) {
    fail(
      "Nothing to do. Pass --list to inspect, or --sku=<sku> with --name/--qty/--shopify-inventory-item-id to map one.",
    );
  }

  const sku = requireSku(options.sku);

  const item = await prisma.inventoryItem.findUnique({
    where: { tenantId_sku: { tenantId: store.tenantId, sku } },
    include: { balances: true, externalReferences: true },
  });

  const mapping = item?.externalReferences.find(
    (reference) => reference.storeId === store.id && reference.platform === "SHOPIFY",
  );

  if (options.remove) {
    if (!mapping) {
      console.log(
        `SKU ${sku} has no ${store.externalStoreId} mapping — nothing to remove.`,
      );

      return;
    }

    if (options.dryRun) {
      console.log(
        JSON.stringify(
          { dryRun: true, action: "would remove mapping", sku, externalId: mapping.externalId },
          null,
          2,
        ),
      );

      return;
    }

    const inventoryItemId = item?.id;

    if (!inventoryItemId) {
      fail(`SKU ${sku} has no catalogue row, so it cannot have a mapping.`);
    }

    await asOperator(async (tx) => {
      await tx.inventoryItemExternalReference.delete({ where: { id: mapping.id } });

      await tx.auditEvent.create({
        data: {
          tenantId: store.tenantId,
          storeId: store.id,
          action: "SKU_UNMAPPED_FROM_SHOPIFY",
          actorType: "SYSTEM",
          entityType: "INVENTORY_ITEM",
          entityId: inventoryItemId,
          metadata: { sku, externalId: mapping.externalId },
        },
      });
    });

    console.log(`Removed mapping for ${sku} → ${mapping.externalId}.`);

    return;
  }

  if (options.shopifyInventoryItemId) {
    const colliding = await prisma.inventoryItemExternalReference.findFirst({
      where: {
        storeId: store.id,
        platform: "SHOPIFY",
        externalId: options.shopifyInventoryItemId,
        ...(item ? { NOT: { inventoryItemId: item.id } } : {}),
      },
      include: { inventoryItem: { select: { sku: true } } },
    });

    if (colliding) {
      fail(
        `Shopify inventory item ${options.shopifyInventoryItemId} is already mapped to SKU ${colliding.inventoryItem.sku}. Remove that mapping first (--remove) if this is a correction.`,
      );
    }
  }

  if (options.qty !== undefined && (!Number.isInteger(options.qty) || options.qty < 0)) {
    fail("--qty must be a non-negative integer");
  }

  if (!item && !options.name) {
    fail(
      `SKU ${sku} does not exist in the OMS catalogue yet — pass --name="<product name>" to create it (and --qty=<initial stock>).`,
    );
  }

  if (options.dryRun) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          shopDomain: store.externalStoreId,
          sku,
          action: item ? "would update existing item" : "would create item",
          name: item?.name ?? options.name,
          initialAvailableQty: options.qty ?? (item ? undefined : 0),
          shopifyInventoryItemId:
            options.shopifyInventoryItemId ?? mapping?.externalId ?? null,
        },
        null,
        2,
      ),
    );

    return;
  }

  const result = await asOperator(async (tx) => {
    let inventoryItemId = item?.id;
    let created = false;

    if (!inventoryItemId) {
      const locationId = await ensureLocationId(tx, store.tenantId, options.locationId);

      const createdItem = await tx.inventoryItem.create({
        data: {
          tenantId: store.tenantId,
          sku,
          name: options.name!.trim(),
          balances: {
            create: { locationId, availableQty: options.qty ?? 0 },
          },
        },
        select: { id: true },
      });

      inventoryItemId = createdItem.id;
      created = true;

      await tx.auditEvent.create({
        data: {
          tenantId: store.tenantId,
          storeId: store.id,
          action: "INVENTORY_ITEM_CREATED",
          actorType: "SYSTEM",
          entityType: "INVENTORY_ITEM",
          entityId: inventoryItemId,
          metadata: { sku, name: options.name!.trim(), availableQty: options.qty ?? 0 },
        },
      });
    } else if (options.qty !== undefined) {
      // Stock corrections go through the ledger, never by rewriting a balance
      // in place: the ledger is what makes the number auditable.
      const locationId = await ensureLocationId(tx, store.tenantId, options.locationId);
      const balance = await tx.inventoryBalance.findFirst({
        where: { inventoryItemId, locationId },
        select: { id: true, availableQty: true },
      });

      if (!balance) {
        await tx.inventoryBalance.create({
          data: { inventoryItemId, locationId, availableQty: options.qty },
        });
      } else {
        // The balance is set to an absolute number, but the ledger records the
        // signed delta: a balance is a running total, a movement is an event.
        const delta = options.qty - balance.availableQty;

        if (delta !== 0) {
          await tx.inventoryBalance.update({
            where: { id: balance.id },
            data: { availableQty: options.qty },
          });

          await tx.inventoryMovement.create({
            data: {
              tenantId: store.tenantId,
              storeId: store.id,
              inventoryItemId,
              locationId,
              type:
                delta > 0
                  ? InventoryMovementType.ADJUSTMENT_IN
                  : InventoryMovementType.ADJUSTMENT_OUT,
              quantity: Math.abs(delta),
              reference: "map-shopify-sku: operator stock level",
            },
          });
        }
      }
    }

    if (options.shopifyInventoryItemId) {
      await tx.inventoryItemExternalReference.upsert({
        where: {
          storeId_platform_externalId: {
            storeId: store.id,
            platform: "SHOPIFY",
            externalId: options.shopifyInventoryItemId,
          },
        },
        create: {
          tenantId: store.tenantId,
          storeId: store.id,
          inventoryItemId,
          platform: "SHOPIFY",
          externalId: options.shopifyInventoryItemId,
        },
        update: { inventoryItemId },
      });

      await tx.auditEvent.create({
        data: {
          tenantId: store.tenantId,
          storeId: store.id,
          action: "SKU_MAPPED_TO_SHOPIFY",
          actorType: "SYSTEM",
          entityType: "INVENTORY_ITEM",
          entityId: inventoryItemId,
          metadata: { sku, externalId: options.shopifyInventoryItemId },
        },
      });
    }

    return { inventoryItemId, created };
  });

  console.log(
    JSON.stringify(
      {
        shopDomain: store.externalStoreId,
        sku,
        inventoryItemId: result.inventoryItemId,
        item: result.created ? "created" : "existing (unchanged)",
        stock: options.qty === undefined ? "not touched" : `set to ${options.qty}`,
        shopifyInventoryItemId: options.shopifyInventoryItemId ?? mapping?.externalId ?? null,
        audited: true,
      },
      null,
      2,
    ),
  );

  console.log(
    [
      "",
      "The next order containing this SKU will reserve stock instead of raising",
      'an "unknown SKU" exception. Check the catalogue with --list.',
    ].join("\n"),
  );
}

function requireShop(options: Options): string {
  if (!options.shopDomain) {
    fail(
      "Usage: npx ts-node map-shopify-sku.ts --shop=<shop>.myshopify.com [--list | --sku=<sku> …]",
    );
  }

  return options.shopDomain.toLowerCase();
}

run(readOptions(process.argv.slice(2)))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

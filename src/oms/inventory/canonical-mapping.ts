import { StorePlatform } from "@prisma/client";

/**
 * THE canonical inventory mapping boundary (locked decision 4).
 *
 * Every resolution of a channel order line to a canonical InventoryItem
 * goes through `resolveCanonicalInventoryItem`, under exactly this rule:
 *
 *   1. PRIMARY — if the line carries an external item reference, look it
 *      up in `InventoryItemExternalReference` by
 *      (storeId, platform, externalId). A mapping hit is authoritative:
 *      it names the item the merchant linked to that channel item, even
 *      when the canonical SKU differs, and even when the linked item is
 *      inactive (the caller fails the line rather than silently
 *      allocating a different item than the merchant mapped).
 *
 *   2. SKU FALLBACK — if the line carries no external item reference, or
 *      no mapping row exists for it, resolve by canonical SKU:
 *      InventoryItem(tenantId, sku.trim()). This is the historical
 *      behaviour and remains the explicitly defined fallback for
 *      channels/events that do not carry item references and for
 *      mappings the merchant has not created yet (e.g. before running
 *      the SKU-mapping operator tool on a freshly connected store).
 *
 *   3. Otherwise the line is unresolvable (null) and the caller applies
 *      its existing failure handling.
 *
 * The function takes the client to run on so callers can resolve inside
 * their own open transaction (allocation resolves under its Serializable
 * transaction and must see the same snapshot).
 */

type MappingClient = {
  inventoryItemExternalReference: {
    findUnique: (args: any) => Promise<any>;
  };
  inventoryItem: {
    findUnique: (args: any) => Promise<any>;
  };
};

export type CanonicalItemLookupInput = {
  tenantId: string;
  storeId: string;
  platform: StorePlatform;
  /** The channel's catalog-item reference for the line, if any. */
  externalItemRef?: string | null;
  /** The channel-observed SKU; the fallback key. */
  sku: string;
};

export async function resolveCanonicalInventoryItem(
  client: MappingClient,
  input: CanonicalItemLookupInput,
): Promise<{ id: string; active: boolean; sku: string } | null> {
  const externalId = input.externalItemRef?.trim() ?? "";

  if (externalId !== "") {
    const mapping =
      await client.inventoryItemExternalReference.findUnique({
        where: {
          storeId_platform_externalId: {
            storeId: input.storeId,
            platform: input.platform,
            externalId,
          },
        },
        include: {
          inventoryItem: true,
        },
      });

    if (mapping) {
      return mapping.inventoryItem;
    }
  }

  return client.inventoryItem.findUnique({
    where: {
      tenantId_sku: {
        tenantId: input.tenantId,
        sku: input.sku.trim(),
      },
    },
  });
}

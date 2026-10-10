import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@prisma/client", () => import("../../../test-utils/prisma-client.mock"));

import { resolveCanonicalInventoryItem } from "./canonical-mapping";

/**
 * The explicitly defined resolution rule (locked decision 4):
 * external-reference primary, SKU fallback, null when unresolvable.
 */
describe("resolveCanonicalInventoryItem", () => {
  const client = {
    inventoryItemExternalReference: { findUnique: vi.fn() },
    inventoryItem: { findUnique: vi.fn() },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    client.inventoryItemExternalReference.findUnique.mockResolvedValue(null);
    client.inventoryItem.findUnique.mockResolvedValue(null);
  });

  const baseInput = {
    tenantId: "tenant-1",
    storeId: "store-1",
    platform: "SHOPIFY" as const,
    sku: "SKU-1",
  };

  it("prefers the external reference mapping over the SKU", async () => {
    client.inventoryItemExternalReference.findUnique.mockResolvedValue({
      inventoryItem: { id: "mapped-1", active: true, sku: "OTHER-SKU" },
    });
    client.inventoryItem.findUnique.mockResolvedValue({
      id: "sku-1",
      active: true,
      sku: "SKU-1",
    });

    const result = await resolveCanonicalInventoryItem(client as never, {
      ...baseInput,
      externalItemRef: "variant-9",
    });

    expect(result?.id).toBe("mapped-1");
    // Primary hit means the SKU lookup must not run.
    expect(client.inventoryItem.findUnique).not.toHaveBeenCalled();
    expect(
      client.inventoryItemExternalReference.findUnique,
    ).toHaveBeenCalledWith({
      where: {
        storeId_platform_externalId: {
          storeId: "store-1",
          platform: "SHOPIFY",
          externalId: "variant-9",
        },
      },
      include: { inventoryItem: true },
    });
  });

  it("treats a mapping as authoritative even when the mapped item is inactive", async () => {
    client.inventoryItemExternalReference.findUnique.mockResolvedValue({
      inventoryItem: { id: "mapped-1", active: false, sku: "OTHER-SKU" },
    });

    const result = await resolveCanonicalInventoryItem(client as never, {
      ...baseInput,
      externalItemRef: "variant-9",
    });

    // The caller fails the line on inactive items rather than silently
    // allocating a different item than the merchant mapped.
    expect(result?.id).toBe("mapped-1");
    expect(result?.active).toBe(false);
    expect(client.inventoryItem.findUnique).not.toHaveBeenCalled();
  });

  it("falls back to canonical SKU when no mapping exists", async () => {
    client.inventoryItem.findUnique.mockResolvedValue({
      id: "sku-1",
      active: true,
      sku: "SKU-1",
    });

    const result = await resolveCanonicalInventoryItem(client as never, {
      ...baseInput,
      sku: "  SKU-1  ",
      externalItemRef: "unmapped-variant",
    });

    expect(result?.id).toBe("sku-1");
    expect(client.inventoryItem.findUnique).toHaveBeenCalledWith({
      where: {
        tenantId_sku: {
          tenantId: "tenant-1",
          sku: "SKU-1",
        },
      },
    });
  });

  it("falls back to canonical SKU when the line carries no external reference", async () => {
    client.inventoryItem.findUnique.mockResolvedValue({
      id: "sku-1",
      active: true,
      sku: "SKU-1",
    });

    const result = await resolveCanonicalInventoryItem(client as never, {
      ...baseInput,
      externalItemRef: null,
    });

    expect(result?.id).toBe("sku-1");
    expect(
      client.inventoryItemExternalReference.findUnique,
    ).not.toHaveBeenCalled();
  });

  it("returns null when nothing resolves", async () => {
    await expect(
      resolveCanonicalInventoryItem(client as never, {
        ...baseInput,
        externalItemRef: "variant-9",
      }),
    ).resolves.toBeNull();
    await expect(
      resolveCanonicalInventoryItem(client as never, {
        ...baseInput,
        externalItemRef: "",
      }),
    ).resolves.toBeNull();
  });
});

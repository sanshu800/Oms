import { NotFoundException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@prisma/client", () => import("../../../test-utils/prisma-client.mock"));

import { InventoryController } from "./inventory.controller";

describe("InventoryController", () => {
  const inventoryService = {
    listItems: vi.fn(),
    getItem: vi.fn(),
  };
  let controller: InventoryController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new InventoryController(inventoryService as any);
  });

  it("lists paginated inventory within the authenticated tenant and store", async () => {
    const result = { items: [], total: 0, page: 1, limit: 50, totalPages: 0 };
    inventoryService.listItems.mockResolvedValue(result);

    await expect(
      controller.listItems("tenant-from-auth", "store-1", "  board ", "2", "25"),
    ).resolves.toBe(result);

    expect(inventoryService.listItems).toHaveBeenCalledWith({
      tenantId: "tenant-from-auth",
      storeId: "store-1",
      query: "board",
      page: 2,
      limit: 25,
    });
  });

  it("returns a single tenant-scoped SKU or a not-found response", async () => {
    const item = { id: "item-1", sku: "SKU-1" };
    inventoryService.getItem.mockResolvedValue(item);

    await expect(
      controller.getItem("SKU-1", "tenant-1", "store-1"),
    ).resolves.toBe(item);
    expect(inventoryService.getItem).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      storeId: "store-1",
      sku: "SKU-1",
    });

    inventoryService.getItem.mockResolvedValue(null);
    await expect(
      controller.getItem("missing", "tenant-1", "store-1"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

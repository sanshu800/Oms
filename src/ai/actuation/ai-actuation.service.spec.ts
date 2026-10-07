import { describe, expect, it, vi } from "vitest";
import { StorePlatform } from "@prisma/client";

import { AiActuationService } from "./ai-actuation.service";

const baseInput = {
  tenantId: "tenant-1",
  storeId: "store-1",
  actionType: "ADD_ORDER_NOTE",
  targetEntityType: "ORDER",
  targetEntityId: "order-1",
  params: {},
};

function buildDeps(storePlatform: StorePlatform | null = StorePlatform.SHOPIFY) {
  const prisma = {
    storeConnection: {
      findFirst: vi.fn().mockResolvedValue(
        storePlatform ? { platform: storePlatform } : null,
      ),
    },
  };

  const shopifyAdapter = {
    platform: StorePlatform.SHOPIFY,
    supports: vi.fn().mockReturnValue(true),
    execute: vi.fn().mockResolvedValue({ success: true }),
    verify: vi.fn().mockResolvedValue(true),
  };

  const service = new AiActuationService(prisma as any, [shopifyAdapter as any]);

  return { service, prisma, shopifyAdapter };
}

describe("AiActuationService", () => {
  it("delegates to the adapter matching the store's platform and the actionType", async () => {
    const { service, shopifyAdapter } = buildDeps();

    const result = await service.execute(baseInput);

    expect(shopifyAdapter.execute).toHaveBeenCalledWith(baseInput);
    expect(result.success).toBe(true);
  });

  it("fails cleanly when no adapter supports the actionType", async () => {
    const { service, shopifyAdapter } = buildDeps();
    shopifyAdapter.supports.mockReturnValue(false);

    const result = await service.execute(baseInput);

    expect(result.success).toBe(false);
    expect(shopifyAdapter.execute).not.toHaveBeenCalled();
  });

  it("fails cleanly when the store doesn't exist", async () => {
    const { service, shopifyAdapter } = buildDeps(null);

    const result = await service.execute(baseInput);

    expect(result.success).toBe(false);
    expect(shopifyAdapter.execute).not.toHaveBeenCalled();
  });

  it("verify() delegates to the same adapter resolution", async () => {
    const { service, shopifyAdapter } = buildDeps();

    const verified = await service.verify(baseInput);

    expect(shopifyAdapter.verify).toHaveBeenCalledWith(baseInput);
    expect(verified).toBe(true);
  });
});

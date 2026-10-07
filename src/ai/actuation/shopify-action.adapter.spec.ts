import { afterEach, describe, expect, it, vi } from "vitest";

import { ShopifyActionAdapter } from "./shopify-action.adapter";
import { encryptSecret } from "../../shopify/shopify-auth.crypto";

const ENCRYPTION_KEY = "a".repeat(32);

function buildDeps() {
  const store = {
    id: "store-1",
    tenantId: "tenant-1",
    shopDomain: "test-shop.myshopify.com",
    encryptedAccessToken: encryptSecret("real-token", ENCRYPTION_KEY),
    scopes: ["read_orders", "write_orders"],
    status: "ACTIVE",
  };

  const prisma = {
    storeConnection: {
      findFirst: vi.fn().mockResolvedValue(store),
    },
    order: {
      findFirst: vi.fn().mockResolvedValue({ externalOrderId: "820982911946" }),
    },
  };

  const config = {
    get: (key: string) => (key === "ENCRYPTION_KEY" ? ENCRYPTION_KEY : undefined),
  };

  const adapter = new ShopifyActionAdapter(prisma as any, config as any);

  return { adapter, prisma, store };
}

const baseInput = {
  tenantId: "tenant-1",
  storeId: "store-1",
  actionType: "ADD_ORDER_NOTE",
  targetEntityType: "ORDER",
  targetEntityId: "order-1",
  params: { note: "Released reservation due to failed payment." },
};

describe("ShopifyActionAdapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("supports only ADD_ORDER_NOTE", () => {
    const { adapter } = buildDeps();

    expect(adapter.supports("ADD_ORDER_NOTE")).toBe(true);
    expect(adapter.supports("CANCEL_ORDER")).toBe(false);
  });

  it("writes the note via Shopify's GraphQL orderUpdate mutation", async () => {
    const { adapter } = buildDeps();

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          orderUpdate: {
            order: { id: "gid://shopify/Order/820982911946", note: baseInput.params.note },
            userErrors: [],
          },
        },
      }),
    });

    vi.stubGlobal("fetch", fetchMock);

    const result = await adapter.execute(baseInput);

    expect(result.success).toBe(true);
    expect(result.externalReference).toBe("gid://shopify/Order/820982911946");

    const [url, requestInit] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toContain("test-shop.myshopify.com/admin/api/");
    expect(requestInit.headers["X-Shopify-Access-Token"]).toBe("real-token");

    const body = JSON.parse(requestInit.body);
    expect(body.variables.input.id).toBe("gid://shopify/Order/820982911946");
    expect(body.variables.input.note).toBe(baseInput.params.note);
  });

  it("fails when Shopify returns userErrors", async () => {
    const { adapter } = buildDeps();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            orderUpdate: {
              order: null,
              userErrors: [{ field: ["note"], message: "Order not found" }],
            },
          },
        }),
      }),
    );

    const result = await adapter.execute(baseInput);

    expect(result.success).toBe(false);
  });

  it("refuses to write when the store hasn't granted the write scope", async () => {
    const { adapter, prisma, store } = buildDeps();

    prisma.storeConnection.findFirst.mockResolvedValue({
      ...store,
      scopes: ["read_orders"],
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await adapter.execute(baseInput);

    expect(result.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("verify() independently re-reads Shopify's note and compares it, not trusting execute()'s own success flag", async () => {
    const { adapter } = buildDeps();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: { order: { id: "gid://shopify/Order/820982911946", note: "a different note" } },
        }),
      }),
    );

    const verified = await adapter.verify(baseInput);

    expect(verified).toBe(false);
  });

  it("verify() returns true when Shopify's actual note matches", async () => {
    const { adapter } = buildDeps();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            order: {
              id: "gid://shopify/Order/820982911946",
              note: baseInput.params.note,
            },
          },
        }),
      }),
    );

    const verified = await adapter.verify(baseInput);

    expect(verified).toBe(true);
  });
});

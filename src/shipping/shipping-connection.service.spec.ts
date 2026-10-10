import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@prisma/client", () => import("../../test-utils/prisma-client.mock"));

import { UnprocessableEntityException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ShippingProvider, StoreConnectionStatus } from "@prisma/client";

import { encryptSecret } from "../shopify/shopify-auth.crypto";

import { ShippingConnectionService } from "./shipping-connection.service";

describe("ShippingConnectionService", () => {
  const prisma = {
    shippingConnection: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
  };

  const config = {
    get: vi.fn(() => "0123456789abcdef0123456789abcdef"),
  } as unknown as ConfigService;

  let service: ShippingConnectionService;

  beforeEach(() => {
    vi.clearAllMocks();

    service = new ShippingConnectionService(prisma as never, config);

    prisma.shippingConnection.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: "connection-1",
        createdAt: new Date("2026-10-09T00:00:00.000Z"),
        updatedAt: new Date("2026-10-09T00:00:00.000Z"),
        connectedAt: new Date("2026-10-09T00:00:00.000Z"),
        disconnectedAt: null,
        ...(data as object),
      }),
    );
  });

  it("encrypts credentials at rest and never returns them", async () => {
    const view = await service.createConnection({
      tenantId: "tenant-1",
      provider: ShippingProvider.FAKE,
      externalAccountId: "acct-1",
      apiKey: "api-secret",
      webhookSecret: "hook-secret",
    });

    const data = (prisma.shippingConnection.create as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as { data: Record<string, unknown> };

    // Stored encrypted — nothing plaintext touches the database.
    expect(data.data.encryptedApiKey).toBeTruthy();
    expect(data.data.encryptedApiKey).not.toBe("api-secret");
    expect(data.data.encryptedWebhookSecret).toBeTruthy();
    expect(data.data.encryptedWebhookSecret).not.toBe("hook-secret");
    expect(String(data.data.encryptedWebhookSecret)).not.toContain("hook-secret");

    // The view exposes existence only.
    expect(view).toMatchObject({
      id: "connection-1",
      provider: ShippingProvider.FAKE,
      externalAccountId: "acct-1",
      status: StoreConnectionStatus.ACTIVE,
      hasApiKey: true,
      hasWebhookSecret: true,
    });
    expect(JSON.stringify(view)).not.toContain("api-secret");
    expect(JSON.stringify(view)).not.toContain("hook-secret");
  });

  it("requires a non-blank external account identity", async () => {
    await expect(
      service.createConnection({
        tenantId: "tenant-1",
        provider: ShippingProvider.FAKE,
        externalAccountId: "   ",
      }),
    ).rejects.toThrow(UnprocessableEntityException);

    expect(prisma.shippingConnection.create).not.toHaveBeenCalled();
  });

  it("requires ENCRYPTION_KEY only when storing credentials", async () => {
    (config.get as ReturnType<typeof vi.fn>).mockReturnValueOnce(undefined);

    await expect(
      service.createConnection({
        tenantId: "tenant-1",
        provider: ShippingProvider.FAKE,
        externalAccountId: "acct-1",
        webhookSecret: "hook-secret",
      }),
    ).rejects.toThrow(UnprocessableEntityException);

    (config.get as ReturnType<typeof vi.fn>).mockReturnValueOnce(undefined);

    await expect(
      service.createConnection({
        tenantId: "tenant-1",
        provider: ShippingProvider.FAKE,
        externalAccountId: "acct-2",
      }),
    ).resolves.toMatchObject({ hasApiKey: false, hasWebhookSecret: false });
  });

  it("lists and reads connections tenant-scoped", async () => {
    prisma.shippingConnection.findMany.mockResolvedValue([
      {
        id: "connection-1",
        tenantId: "tenant-1",
        provider: ShippingProvider.FAKE,
        externalAccountId: "acct-1",
        status: StoreConnectionStatus.ACTIVE,
        encryptedApiKey: encryptSecret("k", "0123456789abcdef0123456789abcdef"),
        encryptedWebhookSecret: null,
        connectedAt: null,
        disconnectedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    prisma.shippingConnection.findFirst.mockResolvedValue(null);

    const list = await service.listConnections("tenant-1");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ hasApiKey: true, hasWebhookSecret: false });

    expect(await service.getConnection({ tenantId: "tenant-1", connectionId: "x" })).toBeNull();

    expect((prisma.shippingConnection.findFirst as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toEqual({
      where: { id: "x", tenantId: "tenant-1" },
    });
  });
});

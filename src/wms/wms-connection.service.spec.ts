import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@prisma/client", () => import("../../test-utils/prisma-client.mock"));

import { UnprocessableEntityException } from "@nestjs/common";
import { StoreConnectionStatus, WmsProvider } from "@prisma/client";

import { decryptSecret } from "../shopify/shopify-auth.crypto";
import { WmsConnectionService } from "./wms-connection.service";

const TEST_ENCRYPTION_KEY = "test-encryption-key-for-wms-secrets";

describe("WmsConnectionService", () => {
  const prisma = {
    wmsConnection: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
  };

  let service: WmsConnectionService;

  beforeEach(() => {
    vi.clearAllMocks();

    service = new WmsConnectionService(prisma as never, {
      get: vi.fn((key: string) =>
        key === "ENCRYPTION_KEY" ? TEST_ENCRYPTION_KEY : undefined,
      ),
    } as never);
  });

  it("encrypts credentials at rest and never returns them", async () => {
    prisma.wmsConnection.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: "connection-1",
        provider: data.provider,
        externalWarehouseId: data.externalWarehouseId,
        locationId: data.locationId,
        status: data.status,
        encryptedApiKey: data.encryptedApiKey,
        encryptedWebhookSecret: data.encryptedWebhookSecret,
        connectedAt: data.connectedAt,
        disconnectedAt: null,
        createdAt: new Date("2026-10-09T10:00:00Z"),
        updatedAt: new Date("2026-10-09T10:00:00Z"),
      }),
    );

    const view = await service.createConnection({
      tenantId: "tenant-1",
      provider: WmsProvider.FAKE,
      externalWarehouseId: "wh-1",
      locationId: "location-1",
      apiKey: "super-secret-api-key",
      webhookSecret: "super-secret-webhook-secret",
    });

    // What reaches the database is ciphertext, and decryptable only with
    // the ENCRYPTION_KEY.
    const stored = prisma.wmsConnection.create.mock.calls[0]![0].data as {
      encryptedApiKey: string;
      encryptedWebhookSecret: string;
    };

    expect(stored.encryptedApiKey).not.toContain("super-secret");
    expect(stored.encryptedWebhookSecret).not.toContain("super-secret");
    expect(decryptSecret(stored.encryptedApiKey, TEST_ENCRYPTION_KEY)).toBe(
      "super-secret-api-key",
    );
    expect(
      decryptSecret(stored.encryptedWebhookSecret, TEST_ENCRYPTION_KEY),
    ).toBe("super-secret-webhook-secret");

    // What callers (and the API) see carries booleans, never the secrets.
    expect(view).toEqual({
      id: "connection-1",
      provider: WmsProvider.FAKE,
      externalWarehouseId: "wh-1",
      locationId: "location-1",
      status: StoreConnectionStatus.ACTIVE,
      hasApiKey: true,
      hasWebhookSecret: true,
      connectedAt: expect.any(Date),
      disconnectedAt: null,
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });

    expect(JSON.stringify(view)).not.toContain("super-secret");
  });

  it("refuses to store credentials without an ENCRYPTION_KEY", async () => {
    service = new WmsConnectionService(prisma as never, {
      get: vi.fn(() => undefined),
    } as never);

    await expect(
      service.createConnection({
        tenantId: "tenant-1",
        provider: WmsProvider.FAKE,
        externalWarehouseId: "wh-1",
        locationId: "location-1",
        webhookSecret: "secret",
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);

    expect(prisma.wmsConnection.create).not.toHaveBeenCalled();
  });

  it("lists connections without any secret material", async () => {
    prisma.wmsConnection.findMany.mockResolvedValue([
      {
        id: "connection-1",
        provider: WmsProvider.FAKE,
        externalWarehouseId: "wh-1",
        locationId: "location-1",
        status: StoreConnectionStatus.ACTIVE,
        encryptedApiKey: "iv.tag.ciphertext",
        encryptedWebhookSecret: null,
        connectedAt: null,
        disconnectedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const views = await service.listConnections("tenant-1");

    expect(prisma.wmsConnection.findMany).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1" },
      orderBy: { createdAt: "asc" },
    });

    expect(views[0]!.hasApiKey).toBe(true);
    expect(views[0]!.hasWebhookSecret).toBe(false);
    expect(JSON.stringify(views)).not.toContain("iv.tag.ciphertext");
  });
});

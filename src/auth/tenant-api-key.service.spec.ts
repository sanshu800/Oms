import { describe, expect, it, vi } from "vitest";

import { TenantApiKeyService } from "./tenant-api-key.service";

function buildDeps() {
  const prisma = {
    tenantApiKey: {
      create: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      findMany: vi.fn(),
    },
    // Real PrismaService's RLS bypass helper just runs the callback
    // directly here — these specs cover the key logic, not RLS
    // plumbing (covered separately by prisma.service specs).
    runAsSystem: vi.fn((fn: () => unknown) => fn()),
  };

  return { service: new TenantApiKeyService(prisma as any), prisma };
}

describe("TenantApiKeyService", () => {
  it("issues a key with the expected prefix and only stores its hash", async () => {
    const { service, prisma } = buildDeps();

    prisma.tenantApiKey.create.mockResolvedValue({ id: "key-1" });

    const { rawKey } = await service.issueKey({
      tenantId: "tenant-1",
      label: "test",
    });

    expect(rawKey.startsWith("tmk_")).toBe(true);

    const createCall = prisma.tenantApiKey.create.mock.calls[0]![0];
    expect(createCall.data.hashedKey).not.toBe(rawKey);
    expect(createCall.data.hashedKey).toMatch(/^[a-f0-9]{64}$/);
  });

  it("resolves the tenantId for a valid, non-revoked key", async () => {
    const { service, prisma } = buildDeps();

    prisma.tenantApiKey.create.mockResolvedValue({ id: "key-1" });
    const { rawKey } = await service.issueKey({
      tenantId: "tenant-1",
      label: "test",
    });

    prisma.tenantApiKey.findUnique.mockResolvedValue({
      tenantId: "tenant-1",
      revokedAt: null,
    });

    const tenantId = await service.resolveTenantId(rawKey);

    expect(tenantId).toBe("tenant-1");
  });

  it("returns null for a malformed key without hitting the database", async () => {
    const { service, prisma } = buildDeps();

    const tenantId = await service.resolveTenantId("not-a-real-key");

    expect(tenantId).toBeNull();
    expect(prisma.tenantApiKey.findUnique).not.toHaveBeenCalled();
  });

  it("returns null for an unknown key", async () => {
    const { service, prisma } = buildDeps();

    prisma.tenantApiKey.findUnique.mockResolvedValue(null);

    const tenantId = await service.resolveTenantId("tmk_" + "0".repeat(64));

    expect(tenantId).toBeNull();
  });

  it("returns null for a revoked key", async () => {
    const { service, prisma } = buildDeps();

    prisma.tenantApiKey.findUnique.mockResolvedValue({
      tenantId: "tenant-1",
      revokedAt: new Date(),
    });

    const tenantId = await service.resolveTenantId("tmk_" + "0".repeat(64));

    expect(tenantId).toBeNull();
  });

  it("revoke only affects the key belonging to that tenant", async () => {
    const { service, prisma } = buildDeps();

    await service.revokeKey({ id: "key-1", tenantId: "tenant-1" });

    expect(prisma.tenantApiKey.updateMany).toHaveBeenCalledWith({
      where: { id: "key-1", tenantId: "tenant-1", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import { ExecutionContext } from "@nestjs/common";

import { TenantApiKeyGuard } from "./tenant-api-key.guard";

function buildContext(authorization?: string) {
  const request: Record<string, unknown> = {
    headers: authorization ? { authorization } : {},
  };

  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;

  return { context, request };
}

describe("TenantApiKeyGuard", () => {
  it("rejects a request with no Authorization header", async () => {
    const tenantApiKeyService = { resolveTenantId: vi.fn() };
    const guard = new TenantApiKeyGuard(tenantApiKeyService as any);
    const { context } = buildContext(undefined);

    await expect(guard.canActivate(context)).rejects.toThrow(
      /Missing Authorization header/,
    );
  });

  it("rejects a non-Bearer scheme", async () => {
    const tenantApiKeyService = { resolveTenantId: vi.fn() };
    const guard = new TenantApiKeyGuard(tenantApiKeyService as any);
    const { context } = buildContext("Basic abc123");

    await expect(guard.canActivate(context)).rejects.toThrow(
      /must be 'Bearer/,
    );
  });

  it("rejects an invalid/unknown key", async () => {
    const tenantApiKeyService = {
      resolveTenantId: vi.fn().mockResolvedValue(null),
    };
    const guard = new TenantApiKeyGuard(tenantApiKeyService as any);
    const { context } = buildContext("Bearer tmk_bogus");

    await expect(guard.canActivate(context)).rejects.toThrow(
      /Invalid or revoked API key/,
    );
  });

  it("attaches the resolved tenantId to the request and allows the call through", async () => {
    const tenantApiKeyService = {
      resolveTenantId: vi.fn().mockResolvedValue("tenant-1"),
    };
    const guard = new TenantApiKeyGuard(tenantApiKeyService as any);
    const { context, request } = buildContext("Bearer tmk_real");

    const allowed = await guard.canActivate(context);

    expect(allowed).toBe(true);
    expect(request.tenantId).toBe("tenant-1");
    expect(tenantApiKeyService.resolveTenantId).toHaveBeenCalledWith(
      "tmk_real",
    );
  });
});

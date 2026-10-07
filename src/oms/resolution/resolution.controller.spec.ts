import { beforeEach, describe, expect, it, vi } from "vitest";

import { ResolutionController } from "./resolution.controller";

describe("ResolutionController", () => {
  let controller: ResolutionController;

  const investigationContextService = {
    getContext: vi.fn(),
  };

  const resolutionService = {
    claim: vi.fn(),
    resolve: vi.fn(),
  };

  const exceptionService = {
    list: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    controller = new ResolutionController(
      resolutionService as any,
      investigationContextService as any,
      exceptionService as any,
    );
  });

  it("should delegate exception claim with actor attribution to ResolutionService", async () => {
    const result = {
      id: "exception-claim-1",
      status: "INVESTIGATING",
    };

    resolutionService.claim.mockResolvedValue(result);

    await expect(
      controller.claimException(
        "exception-claim-1",
        "tenant-1",
        "store-1",
        { actorType: "USER", actorId: "operator-1" },
      ),
    ).resolves.toEqual(result);

    expect(resolutionService.claim).toHaveBeenCalledTimes(1);
    expect(resolutionService.claim).toHaveBeenCalledWith({
      exceptionId: "exception-claim-1",
      tenantId: "tenant-1",
      storeId: "store-1",
      actorType: "USER",
      actorId: "operator-1",
    });
  });
  it("should delegate exception resolution to ResolutionService", async () => {
    const result = {
      exceptionId: "exception-1",
      action: "RELEASE_ORDER_RESERVATION",
      executed: true,
      verified: true,
      resolved: true,
    };

    resolutionService.resolve.mockResolvedValue(result);

    await expect(
      controller.resolveException("exception-1", "tenant-1", "store-1"),
    ).resolves.toEqual(result);

    expect(resolutionService.resolve).toHaveBeenCalledTimes(1);

    expect(resolutionService.resolve).toHaveBeenCalledWith({
      exceptionId: "exception-1",
      tenantId: "tenant-1",
      storeId: "store-1",
    });
  });

  it("should preserve a blocked resolution result", async () => {
    const result = {
      exceptionId: "exception-2",
      action: "MANUAL_INVESTIGATION_REQUIRED",
      executed: false,
      verified: false,
      resolved: false,
      reason: "No safe deterministic resolution strategy exists",
    };

    resolutionService.resolve.mockResolvedValue(result);

    await expect(
      controller.resolveException("exception-2", "tenant-1", "store-1"),
    ).resolves.toEqual(result);
  });

  it("should propagate ResolutionService errors", async () => {
    resolutionService.resolve.mockRejectedValue(
      new Error("Operational exception not found"),
    );

    await expect(
      controller.resolveException("missing-exception", "tenant-1", "store-1"),
    ).rejects.toThrow("Operational exception not found");
  });
});

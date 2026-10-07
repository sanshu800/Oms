import { describe, expect, it, vi } from "vitest";

import { ResolutionService } from "./resolution.service";
import { InvestigationDecisionService } from "../investigation/investigation-decision.service";

describe("ResolutionService", () => {

  const investigationDecisionService = new InvestigationDecisionService();
  function createService() {
    const prisma = {
      inventoryReservation: {
        findMany: vi.fn(),
      },
    };

    const exceptionService = {
      getById: vi.fn(),
      claim: vi.fn(),
      resolve: vi.fn(),
    };

    const inventoryService = {
      releaseOrder: vi.fn(),
    };

    const auditService = {
      recordEvent: vi.fn(),
    };

    return {
      service: new ResolutionService(
        prisma as any,
        exceptionService as any,
        inventoryService as any,
        auditService as any,
    investigationDecisionService as any,
      ),
      prisma,
      exceptionService,
      inventoryService,
      auditService,
    };
  }

  it("should claim an open exception and record actor attribution", async () => {
    const { service, exceptionService, auditService } = createService();

    const exception = {
      id: "exception-claim-1",
      status: "OPEN",
      category: "ORDER_OPERATIONAL_RISK",
      fingerprint: "insufficient-inventory:order-claim-1",
      evidence: {
        orderId: "order-claim-1",
      },
    };

    exceptionService.getById.mockResolvedValue(exception);
    exceptionService.claim.mockResolvedValue({
      ...exception,
      status: "INVESTIGATING",
    });

    const result = await service.claim({
      tenantId: "tenant-1",
      storeId: "store-1",
      exceptionId: "exception-claim-1",
      actorType: "USER",
      actorId: "operator-1",
    });

    expect(exceptionService.claim).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      storeId: "store-1",
      exceptionId: "exception-claim-1",
    });

    expect(auditService.recordEvent).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      storeId: "store-1",
      action: "EXCEPTION_CLAIMED",
      actorType: "USER",
      actorId: "operator-1",
      entityType: "OPERATIONAL_EXCEPTION",
      entityId: "exception-claim-1",
      metadata: {
        previousStatus: "OPEN",
        newStatus: "INVESTIGATING",
      },
    });

    expect(result.status).toBe("INVESTIGATING");
  });

  it("should make an already investigating claim idempotent", async () => {
    const { service, exceptionService, auditService } = createService();

    const exception = {
      id: "exception-claim-2",
      status: "INVESTIGATING",
      category: "ORDER_OPERATIONAL_RISK",
      fingerprint: "insufficient-inventory:order-claim-2",
      evidence: {
        orderId: "order-claim-2",
      },
    };

    exceptionService.getById.mockResolvedValue(exception);
    exceptionService.claim.mockResolvedValue(exception);

    const result = await service.claim({
      tenantId: "tenant-1",
      storeId: "store-1",
      exceptionId: "exception-claim-2",
      actorType: "SYSTEM",
      actorId: "investigation-agent",
    });

    expect(result).toEqual(exception);
    expect(exceptionService.claim).toHaveBeenCalledOnce();
    expect(auditService.recordEvent).not.toHaveBeenCalled();
  });

  it("should reject claiming a resolved exception", async () => {
    const { service, exceptionService, auditService } = createService();

    const exception = {
      id: "exception-claim-3",
      status: "RESOLVED",
      category: "ORDER_OPERATIONAL_RISK",
      fingerprint: "insufficient-inventory:order-claim-3",
      evidence: {
        orderId: "order-claim-3",
      },
    };

    exceptionService.getById.mockResolvedValue(exception);
    exceptionService.claim.mockRejectedValue(
      new Error("Resolved operational exception cannot be claimed"),
    );

    await expect(
      service.claim({
        tenantId: "tenant-1",
        storeId: "store-1",
        exceptionId: "exception-claim-3",
        actorType: "SYSTEM",
      }),
    ).rejects.toThrow("Resolved operational exception cannot be claimed");

    expect(auditService.recordEvent).not.toHaveBeenCalled();
  });
  it("should release an active reservation and resolve a failed-order exception", async () => {
    const {
      service,
      prisma,
      exceptionService,
      inventoryService,
      auditService,
    } = createService();

    exceptionService.getById.mockResolvedValue({
      id: "exception-1",
      status: "INVESTIGATING",
      category: "ORDER_INTEGRITY",
      fingerprint: "failed-order-with-reservation:order-1",
      evidence: {
        orderId: "order-1",
      },
    });

    inventoryService.releaseOrder.mockResolvedValue({
      released: true,
      reservationCount: 1,
    });

    prisma.inventoryReservation.findMany.mockResolvedValueOnce([]);

    exceptionService.resolve.mockResolvedValue({
      id: "exception-1",
      status: "RESOLVED",
    });

    const result = await service.resolve({
      tenantId: "tenant-1",
      storeId: "store-1",
      exceptionId: "exception-1",
    });

    expect(inventoryService.releaseOrder).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      storeId: "store-1",
      orderId: "order-1",
    });

    expect(exceptionService.resolve).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      storeId: "store-1",
      exceptionId: "exception-1",
    });

    expect(result).toEqual({
      exceptionId: "exception-1",
      action: "RELEASE_ORDER_RESERVATION",
      executed: true,
      verified: true,
      resolved: true,
    });

    expect(auditService.recordEvent).toHaveBeenCalled();
  });

  it("should reject resolution of an open exception before investigation", async () => {
    const {
      service,
      exceptionService,
      inventoryService,
    } = createService();

    exceptionService.getById.mockResolvedValue({
      id: "exception-open-1",
      status: "OPEN",
      category: "ORDER_INTEGRITY",
      fingerprint: "failed-order-with-reservation:order-open-1",
      evidence: {
        orderId: "order-open-1",
      },
    });

    const result = await service.resolve({
      tenantId: "tenant-1",
      storeId: "store-1",
      exceptionId: "exception-open-1",
    });

    expect(result.resolved).toBe(false);
    expect(result.executed).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.reason).toBe(
      "Exception must be claimed for investigation before resolution",
    );

    expect(inventoryService.releaseOrder).not.toHaveBeenCalled();
    expect(exceptionService.resolve).not.toHaveBeenCalled();
  });
  it("should leave unsupported risks open", async () => {
    const { service, exceptionService, inventoryService, auditService } =
      createService();

    exceptionService.getById.mockResolvedValue({
      id: "exception-2",
      status: "INVESTIGATING",
      category: "INVENTORY_INTEGRITY",
      fingerprint: "inventory-negative:item-1:location-1",
      evidence: {
        inventoryItemId: "item-1",
      },
    });

    const result = await service.resolve({
      tenantId: "tenant-1",
      storeId: "store-1",
      exceptionId: "exception-2",
    });

    expect(result).toEqual({
      exceptionId: "exception-2",
      action: "MANUAL_INVESTIGATION_REQUIRED",
      executed: false,
      verified: false,
      resolved: false,
      reason: "No safe deterministic resolution strategy exists",
    });

    expect(inventoryService.releaseOrder).not.toHaveBeenCalled();

    expect(exceptionService.resolve).not.toHaveBeenCalled();

    expect(auditService.recordEvent).toHaveBeenCalled();
  });

  it("should audit recovery execution failure and leave the exception unresolved", async () => {
    const {
      service,
      exceptionService,
      inventoryService,
      auditService,
    } = createService();

    exceptionService.getById.mockResolvedValue({
      id: "exception-execution-failure",
      status: "INVESTIGATING",
      category: "ORDER_INTEGRITY",
      fingerprint: "failed-order-with-reservation:order-failure",
      evidence: {
        orderId: "order-failure",
      },
    });

    const recoveryError = new Error("Inventory release failed");

    inventoryService.releaseOrder.mockRejectedValue(recoveryError);

    await expect(
      service.resolve({
        tenantId: "tenant-1",
        storeId: "store-1",
        exceptionId: "exception-execution-failure",
      }),
    ).rejects.toThrow("Inventory release failed");

    expect(exceptionService.resolve).not.toHaveBeenCalled();

    expect(auditService.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "EXCEPTION_RESOLUTION_FAILED",
        entityType: "OPERATIONAL_EXCEPTION",
        entityId: "exception-execution-failure",
        metadata: expect.objectContaining({
          action: "RELEASE_ORDER_RESERVATION",
          orderId: "order-failure",
          error: "Inventory release failed",
        }),
      }),
    );
  });

  it("should verify persisted state before resolving", async () => {
    const { service, prisma, exceptionService, inventoryService } =
      createService();

    exceptionService.getById.mockResolvedValue({
      id: "exception-3",
      status: "INVESTIGATING",
      category: "ORDER_INTEGRITY",
      fingerprint: "failed-order-with-reservation:order-3",
      evidence: {
        orderId: "order-3",
      },
    });

    inventoryService.releaseOrder.mockResolvedValue({
      released: true,
      reservationCount: 1,
    });

    prisma.inventoryReservation.findMany.mockResolvedValue([
      {
        id: "still-active",
      },
    ]);

    const result = await service.resolve({
      tenantId: "tenant-1",
      storeId: "store-1",
      exceptionId: "exception-3",
    });

    expect(result.verified).toBe(false);
    expect(result.resolved).toBe(false);

    expect(exceptionService.resolve).not.toHaveBeenCalled();
  });

  it("should be idempotent for an already resolved exception", async () => {
    const { service, exceptionService, inventoryService } = createService();

    exceptionService.getById.mockResolvedValue({
      id: "exception-4",
      status: "RESOLVED",
      category: "ORDER_INTEGRITY",
      fingerprint: "failed-order-with-reservation:order-4",
      evidence: {
        orderId: "order-4",
      },
    });

    const result = await service.resolve({
      tenantId: "tenant-1",
      storeId: "store-1",
      exceptionId: "exception-4",
    });

    expect(result.resolved).toBe(true);
    expect(result.executed).toBe(false);

    expect(inventoryService.releaseOrder).not.toHaveBeenCalled();
  });
});











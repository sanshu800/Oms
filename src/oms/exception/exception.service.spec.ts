import { describe, expect, it, vi } from "vitest";
import { ExceptionService } from "./exception.service";
import { ExceptionSeverity, ExceptionStatus } from "@prisma/client";

describe("ExceptionService", () => {
  function createService() {
    const prisma = {
      operationalException: {
        upsert: vi.fn(),
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn(),
        findMany: vi.fn(),
        update: vi.fn(),
      },
    };

    const aiInvestigationQueue = {
      isEligibleCategory: vi.fn().mockReturnValue(false),
      enqueue: vi.fn(),
    };

    return {
      service: new ExceptionService(prisma as any, aiInvestigationQueue as any),
      prisma,
      aiInvestigationQueue,
    };
  }

  it("should create or update an operational exception", async () => {
    const { service, prisma } = createService();

    const exception = {
      id: "exception-1",
      tenantId: "tenant-1",
      storeId: "store-1",
      fingerprint: "ORDER_PAYMENT_FULFILLMENT_1001",
      category: "ORDER_OPERATIONAL_RISK",
      severity: ExceptionSeverity.HIGH,
      status: ExceptionStatus.OPEN,
    };

    prisma.operationalException.upsert.mockResolvedValue(exception);

    const result = await service.raise({
      tenantId: "tenant-1",
      storeId: "store-1",
      fingerprint: "ORDER_PAYMENT_FULFILLMENT_1001",
      category: "ORDER_OPERATIONAL_RISK",
      severity: ExceptionSeverity.HIGH,
      title: "Paid order requires operational attention",
      evidence: {
        orderId: "order-1",
      },
      recommendedNextStep: "Investigate order fulfillment state.",
    });

    expect(result).toEqual(exception);
    expect(prisma.operationalException.upsert).toHaveBeenCalledOnce();
  });

  it("should deduplicate an active exception with the same fingerprint", async () => {
    const { service, prisma } = createService();

    const existing = {
      id: "exception-existing",
      tenantId: "tenant-1",
      storeId: "store-1",
      fingerprint: "ORDER_INVENTORY_FAILURE:order-1:sku-1",
      category: "ORDER_INTEGRITY",
      severity: ExceptionSeverity.HIGH,
      status: ExceptionStatus.OPEN,
    };

    prisma.operationalException.upsert.mockResolvedValue(existing);

    const result = await service.raise({
      tenantId: "tenant-1",
      storeId: "store-1",
      fingerprint: "ORDER_INVENTORY_FAILURE:order-1:sku-1",
      category: "ORDER_INTEGRITY",
      severity: ExceptionSeverity.HIGH,
      title: "Insufficient inventory",
      evidence: {
        orderId: "order-1",
        sku: "sku-1",
        requestedQty: 2,
        availableQty: 1,
      },
      recommendedNextStep: "Investigate inventory availability.",
    });

    expect(result.id).toBe("exception-existing");
    expect(result.status).toBe(ExceptionStatus.OPEN);
    expect(prisma.operationalException.upsert).toHaveBeenCalledOnce();
  });

  it("should reopen the same exception when a resolved fingerprint reappears", async () => {
    const { service, prisma } = createService();

    const reopened = {
      id: "exception-resolved",
      tenantId: "tenant-1",
      storeId: "store-1",
      fingerprint: "ORDER_INVENTORY_FAILURE:order-1:sku-1",
      category: "ORDER_INTEGRITY",
      severity: ExceptionSeverity.HIGH,
      status: ExceptionStatus.OPEN,
      resolvedAt: null,
    };

    prisma.operationalException.upsert.mockResolvedValue(reopened);

    const result = await service.raise({
      tenantId: "tenant-1",
      storeId: "store-1",
      fingerprint: "ORDER_INVENTORY_FAILURE:order-1:sku-1",
      category: "ORDER_INTEGRITY",
      severity: ExceptionSeverity.HIGH,
      title: "Insufficient inventory returned",
      evidence: {
        orderId: "order-1",
        sku: "sku-1",
        requestedQty: 2,
        availableQty: 1,
      },
      recommendedNextStep: "Investigate recurring inventory shortage.",
    });

    expect(result.id).toBe("exception-resolved");
    expect(result.status).toBe(ExceptionStatus.OPEN);
    expect(result.resolvedAt).toBeNull();
    expect(prisma.operationalException.upsert).toHaveBeenCalledOnce();
  });
  it("should enqueue an AI investigation for a new exception in an eligible category", async () => {
    const { service, prisma, aiInvestigationQueue } = createService();

    aiInvestigationQueue.isEligibleCategory.mockReturnValue(true);
    prisma.operationalException.findUnique.mockResolvedValue(null);
    prisma.operationalException.upsert.mockResolvedValue({
      id: "exception-new",
      status: ExceptionStatus.OPEN,
    });

    await service.raise({
      tenantId: "tenant-1",
      storeId: "store-1",
      fingerprint: "INVENTORY_INTEGRITY:sku-1",
      category: "INVENTORY_INTEGRITY",
      severity: ExceptionSeverity.HIGH,
      title: "Negative inventory",
      evidence: { sku: "sku-1" },
      recommendedNextStep: "Reconcile.",
    });

    expect(aiInvestigationQueue.enqueue).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      storeId: "store-1",
      exceptionId: "exception-new",
    });
  });

  it("should enqueue an AI investigation when a resolved exception reopens", async () => {
    const { service, prisma, aiInvestigationQueue } = createService();

    aiInvestigationQueue.isEligibleCategory.mockReturnValue(true);
    prisma.operationalException.findUnique.mockResolvedValue({
      id: "exception-1",
      status: ExceptionStatus.RESOLVED,
    });
    prisma.operationalException.upsert.mockResolvedValue({
      id: "exception-1",
      status: ExceptionStatus.OPEN,
    });

    await service.raise({
      tenantId: "tenant-1",
      storeId: "store-1",
      fingerprint: "INVENTORY_INTEGRITY:sku-1",
      category: "INVENTORY_INTEGRITY",
      severity: ExceptionSeverity.HIGH,
      title: "Negative inventory returned",
      evidence: { sku: "sku-1" },
      recommendedNextStep: "Reconcile.",
    });

    expect(aiInvestigationQueue.enqueue).toHaveBeenCalledOnce();
  });

  it("should not enqueue an AI investigation for an exception that is already open", async () => {
    const { service, prisma, aiInvestigationQueue } = createService();

    aiInvestigationQueue.isEligibleCategory.mockReturnValue(true);
    prisma.operationalException.findUnique.mockResolvedValue({
      id: "exception-1",
      status: ExceptionStatus.OPEN,
    });
    prisma.operationalException.upsert.mockResolvedValue({
      id: "exception-1",
      status: ExceptionStatus.OPEN,
    });

    await service.raise({
      tenantId: "tenant-1",
      storeId: "store-1",
      fingerprint: "INVENTORY_INTEGRITY:sku-1",
      category: "INVENTORY_INTEGRITY",
      severity: ExceptionSeverity.HIGH,
      title: "Negative inventory, still open",
      evidence: { sku: "sku-1" },
      recommendedNextStep: "Reconcile.",
    });

    expect(aiInvestigationQueue.enqueue).not.toHaveBeenCalled();
  });

  it("should not enqueue an AI investigation for an ineligible category", async () => {
    const { service, prisma, aiInvestigationQueue } = createService();

    aiInvestigationQueue.isEligibleCategory.mockReturnValue(false);
    prisma.operationalException.findUnique.mockResolvedValue(null);
    prisma.operationalException.upsert.mockResolvedValue({
      id: "exception-new",
      status: ExceptionStatus.OPEN,
    });

    await service.raise({
      tenantId: "tenant-1",
      storeId: "store-1",
      fingerprint: "WEBHOOK_PROCESSING:evt-1",
      category: "WEBHOOK_PROCESSING",
      severity: ExceptionSeverity.HIGH,
      title: "Webhook failed",
      evidence: {},
      recommendedNextStep: "Retry.",
    });

    expect(aiInvestigationQueue.enqueue).not.toHaveBeenCalled();
  });

  it("should resolve an open exception", async () => {
    const { service, prisma } = createService();

    prisma.operationalException.findFirst.mockResolvedValue({
      id: "exception-1",
      status: ExceptionStatus.OPEN,
    });

    prisma.operationalException.update.mockResolvedValue({
      id: "exception-1",
      status: ExceptionStatus.RESOLVED,
      resolvedAt: new Date(),
    });

    const result = await service.resolve({
      tenantId: "tenant-1",
      storeId: "store-1",
      exceptionId: "exception-1",
    });

    expect(result.status).toBe(ExceptionStatus.RESOLVED);

    expect(prisma.operationalException.update).toHaveBeenCalledOnce();
  });

  it("should not update an already resolved exception", async () => {
    const { service, prisma } = createService();

    const exception = {
      id: "exception-1",
      status: ExceptionStatus.RESOLVED,
    };

    prisma.operationalException.findFirst.mockResolvedValue(exception);

    const result = await service.resolve({
      tenantId: "tenant-1",
      storeId: "store-1",
      exceptionId: "exception-1",
    });

    expect(result).toEqual(exception);

    expect(prisma.operationalException.update).not.toHaveBeenCalled();
  });

  it("should return open exceptions", async () => {
    const { service, prisma } = createService();

    const exceptions = [
      {
        id: "exception-1",
        status: ExceptionStatus.OPEN,
      },
    ];

    prisma.operationalException.findMany.mockResolvedValue(exceptions);

    const result = await service.getOpenExceptions({
      tenantId: "tenant-1",
      storeId: "store-1",
    });

    expect(result).toEqual(exceptions);
    expect(prisma.operationalException.findMany).toHaveBeenCalledOnce();
  });

  it("should reopen an exception", async () => {
    const { service, prisma } = createService();

    prisma.operationalException.findFirst.mockResolvedValue({
      id: "exception-1",
      status: ExceptionStatus.RESOLVED,
    });

    prisma.operationalException.update.mockResolvedValue({
      id: "exception-1",
      status: ExceptionStatus.OPEN,
      resolvedAt: null,
    });

    const result = await service.reopen({
      tenantId: "tenant-1",
      storeId: "store-1",
      exceptionId: "exception-1",
      evidence: {
        verification: "condition_still_exists",
      },
      recommendedNextStep: "Retry operational resolution.",
    });

    expect(result.status).toBe(ExceptionStatus.OPEN);

    expect(prisma.operationalException.update).toHaveBeenCalledOnce();
  });
  it("should claim an open exception for investigation", async () => {
    const { service, prisma } = createService();

    const exception = {
      id: "exception-1",
      tenantId: "tenant-1",
      storeId: "store-1",
      status: ExceptionStatus.OPEN,
    };

    prisma.operationalException.findFirst.mockResolvedValue(exception);
    prisma.operationalException.update.mockResolvedValue({
      ...exception,
      status: ExceptionStatus.INVESTIGATING,
    });

    const result = await service.claim({
      tenantId: "tenant-1",
      storeId: "store-1",
      exceptionId: "exception-1",
    });

    expect(result.status).toBe(ExceptionStatus.INVESTIGATING);
    expect(prisma.operationalException.findFirst).toHaveBeenCalledOnce();
    expect(prisma.operationalException.update).toHaveBeenCalledWith({
      where: { id: "exception-1" },
      data: { status: ExceptionStatus.INVESTIGATING },
    });
  });

  it("should not update an exception that is already investigating", async () => {
    const { service, prisma } = createService();

    const exception = {
      id: "exception-1",
      tenantId: "tenant-1",
      storeId: "store-1",
      status: ExceptionStatus.INVESTIGATING,
    };

    prisma.operationalException.findFirst.mockResolvedValue(exception);

    const result = await service.claim({
      tenantId: "tenant-1",
      storeId: "store-1",
      exceptionId: "exception-1",
    });

    expect(result).toEqual(exception);
    expect(prisma.operationalException.update).not.toHaveBeenCalled();
  });

  it("should reject claiming a resolved exception", async () => {
    const { service, prisma } = createService();

    prisma.operationalException.findFirst.mockResolvedValue({
      id: "exception-1",
      tenantId: "tenant-1",
      storeId: "store-1",
      status: ExceptionStatus.RESOLVED,
    });

    await expect(
      service.claim({
        tenantId: "tenant-1",
        storeId: "store-1",
        exceptionId: "exception-1",
      }),
    ).rejects.toThrow("Resolved operational exception cannot be claimed");

    expect(prisma.operationalException.update).not.toHaveBeenCalled();
  });

  it("should reject claiming a nonexistent exception", async () => {
    const { service, prisma } = createService();

    prisma.operationalException.findFirst.mockResolvedValue(null);

    await expect(
      service.claim({
        tenantId: "tenant-1",
        storeId: "store-1",
        exceptionId: "exception-1",
      }),
    ).rejects.toThrow("Operational exception not found");

    expect(prisma.operationalException.update).not.toHaveBeenCalled();
  });
});



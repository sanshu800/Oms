import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@prisma/client", () => import("../../test-utils/prisma-client.mock"));

import { UnprocessableEntityException } from "@nestjs/common";
import {
  StoreConnectionStatus,
  WmsProvider,
  WmsRequestStatus,
} from "@prisma/client";

import { WmsRequestService } from "./wms-request.service";
import {
  WMS_CONTRACT_VERSION,
  WmsAdapter,
  WmsSubmitFulfillmentRequestCommand,
} from "./wms-contract";

function makeAdapter(overrides: Partial<WmsAdapter> = {}): WmsAdapter {
  return {
    provider: WmsProvider.FAKE,
    contractVersion: WMS_CONTRACT_VERSION,
    capabilities: ["fulfillment.submit"],
    submitFulfillmentRequest: vi.fn(async (command: WmsSubmitFulfillmentRequestCommand) => ({
      externalRequestId: `fake-wms-${command.idempotencyKey}`,
    })),
    readInboundEnvelope: vi.fn(),
    verifyInbound: vi.fn(),
    ...overrides,
  };
}

describe("WmsRequestService", () => {
  const prisma = {
    wmsConnection: { findFirst: vi.fn() },
    wmsFulfillmentRequest: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  };

  const fulfillmentService = {
    getById: vi.fn(),
  };

  const auditService = {
    recordEvent: vi.fn(),
  };

  let adapter: WmsAdapter;
  let service: WmsRequestService;

  function fulfillment() {
    return {
      id: "fulfillment-1",
      tenantId: "tenant-1",
      storeId: "store-1",
      locationId: "location-1",
      status: "READY",
      order: { orderNumber: "#1001" },
      items: [
        {
          id: "fi-1",
          orderItemId: "oi-1",
          reservationId: "res-1",
          inventoryItemId: "inv-1",
          quantity: 3,
          inventoryItem: { id: "inv-1", sku: "SKU-1" },
        },
      ],
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();

    adapter = makeAdapter();
    service = new WmsRequestService(
      prisma as never,
      fulfillmentService as never,
      auditService as never,
      [adapter],
    );

    fulfillmentService.getById.mockResolvedValue(fulfillment());
    prisma.wmsConnection.findFirst.mockResolvedValue({
      id: "connection-1",
      tenantId: "tenant-1",
      provider: WmsProvider.FAKE,
      externalWarehouseId: "wh-1",
      locationId: "location-1",
      status: StoreConnectionStatus.ACTIVE,
    });
    prisma.wmsFulfillmentRequest.findUnique.mockResolvedValue(null);
    prisma.wmsFulfillmentRequest.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: "request-1",
        status: WmsRequestStatus.PENDING,
        externalRequestId: null,
        ...(data as object),
      }),
    );
    prisma.wmsFulfillmentRequest.update.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: "request-1",
        status: data.status ?? WmsRequestStatus.PENDING,
        externalRequestId:
          (data.externalRequestId as string | null | undefined) ?? null,
      }),
    );
  });

  it("submits one idempotent fulfillment request through the contract", async () => {
    const result = await service.submitFulfillmentRequest({
      tenantId: "tenant-1",
      storeId: "store-1",
      fulfillmentId: "fulfillment-1",
    });

    expect(result).toEqual({
      requestId: "request-1",
      status: WmsRequestStatus.SUBMITTED,
      externalRequestId: "fake-wms-fulfillment-1",
    });

    // Exactly one adapter call, carrying the pinned contract version and
    // the deterministic idempotency key.
    expect(adapter.submitFulfillmentRequest).toHaveBeenCalledTimes(1);

    const command = (adapter.submitFulfillmentRequest as ReturnType<typeof vi.fn>)
      .mock.calls[0]![0] as WmsSubmitFulfillmentRequestCommand;

    expect(command.contractVersion).toBe(WMS_CONTRACT_VERSION);
    expect(command.idempotencyKey).toBe("fulfillment-1");
    expect(command.request.requestRef).toBe("fulfillment-1");
    expect(command.request.orderReference).toBe("#1001");
    expect(command.request.lines).toEqual([
      { externalLineRef: "oi-1", sku: "SKU-1", quantity: 3 },
    ]);

    expect(auditService.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "WMS_FULFILLMENT_REQUEST_SUBMITTED" }),
    );
  });

  it("returns the existing request on resubmit — no second warehouse request", async () => {
    prisma.wmsFulfillmentRequest.findUnique.mockResolvedValue({
      id: "request-1",
      status: WmsRequestStatus.SUBMITTED,
      externalRequestId: "fake-wms-fulfillment-1",
    });

    const result = await service.submitFulfillmentRequest({
      tenantId: "tenant-1",
      storeId: "store-1",
      fulfillmentId: "fulfillment-1",
    });

    expect(result.status).toBe(WmsRequestStatus.SUBMITTED);
    expect(adapter.submitFulfillmentRequest).not.toHaveBeenCalled();
    expect(prisma.wmsFulfillmentRequest.create).not.toHaveBeenCalled();
  });

  it("retries a failed submit with the SAME idempotency key", async () => {
    prisma.wmsFulfillmentRequest.findUnique.mockResolvedValue({
      id: "request-1",
      status: WmsRequestStatus.FAILED,
      externalRequestId: null,
    });

    (adapter.submitFulfillmentRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
      externalRequestId: "fake-wms-fulfillment-1",
    });

    await service.submitFulfillmentRequest({
      tenantId: "tenant-1",
      storeId: "store-1",
      fulfillmentId: "fulfillment-1",
    });

    expect(adapter.submitFulfillmentRequest).toHaveBeenCalledTimes(1);

    const command = (adapter.submitFulfillmentRequest as ReturnType<typeof vi.fn>)
      .mock.calls[0]![0] as WmsSubmitFulfillmentRequestCommand;

    expect(command.idempotencyKey).toBe("fulfillment-1");
  });

  it("records a failed submit and marks the request FAILED", async () => {
    (adapter.submitFulfillmentRequest as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("warehouse unavailable"),
    );

    await expect(
      service.submitFulfillmentRequest({
        tenantId: "tenant-1",
        storeId: "store-1",
        fulfillmentId: "fulfillment-1",
      }),
    ).rejects.toThrow("warehouse unavailable");

    expect(prisma.wmsFulfillmentRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: WmsRequestStatus.FAILED,
          lastError: "warehouse unavailable",
        }),
      }),
    );

    expect(auditService.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "WMS_FULFILLMENT_REQUEST_FAILED" }),
    );
  });

  it("requires an active WMS connection for the fulfillment's location", async () => {
    prisma.wmsConnection.findFirst.mockResolvedValue(null);

    await expect(
      service.submitFulfillmentRequest({
        tenantId: "tenant-1",
        storeId: "store-1",
        fulfillmentId: "fulfillment-1",
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("never calls an adapter for capabilities it does not declare", async () => {
    adapter = makeAdapter({ capabilities: [] });
    service = new WmsRequestService(
      prisma as never,
      fulfillmentService as never,
      auditService as never,
      [adapter],
    );

    await expect(
      service.submitFulfillmentRequest({
        tenantId: "tenant-1",
        storeId: "store-1",
        fulfillmentId: "fulfillment-1",
      }),
    ).rejects.toThrow("does not support fulfillment.submit");

    expect(adapter.submitFulfillmentRequest).not.toHaveBeenCalled();
  });

  it("rejects an adapter speaking a different contract version", async () => {
    adapter = makeAdapter({ contractVersion: "0.9" });
    service = new WmsRequestService(
      prisma as never,
      fulfillmentService as never,
      auditService as never,
      [adapter],
    );

    await expect(
      service.submitFulfillmentRequest({
        tenantId: "tenant-1",
        storeId: "store-1",
        fulfillmentId: "fulfillment-1",
      }),
    ).rejects.toThrow("WMS contract version mismatch");

    expect(adapter.submitFulfillmentRequest).not.toHaveBeenCalled();
  });

  it("scopes the fulfillment to the authenticated tenant", async () => {
    await service.submitFulfillmentRequest({
      tenantId: "tenant-1",
      storeId: "store-1",
      fulfillmentId: "fulfillment-1",
    });

    expect(fulfillmentService.getById).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      storeId: "store-1",
      fulfillmentId: "fulfillment-1",
    });
  });
});

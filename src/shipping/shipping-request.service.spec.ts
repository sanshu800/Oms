import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@prisma/client", () => import("../../test-utils/prisma-client.mock"));

import { UnprocessableEntityException } from "@nestjs/common";
import {
  ShippingProvider,
  ShippingRequestStatus,
  ShipmentStatus,
  StoreConnectionStatus,
} from "@prisma/client";

import {
  SHIPPING_CONTRACT_VERSION,
  ShippingCapability,
  ShippingProviderAdapter,
  ShippingProviderError,
  ShippingProviderStatus,
} from "./shipping-contract";
import { ShippingRequestService } from "./shipping-request.service";

function makeAdapter(overrides: Partial<ShippingProviderAdapter> = {}): ShippingProviderAdapter {
  return {
    provider: ShippingProvider.FAKE,
    contractVersion: SHIPPING_CONTRACT_VERSION,
    capabilities: [
      ShippingCapability.SHIPMENT_CREATE,
      ShippingCapability.SHIPMENT_CANCEL,
    ],
    createShipment: vi.fn(async (request) => ({
      externalShipmentId: `fake-ship-${request.requestId}`,
      externalOrderId: `fake-sorder-${request.requestId}`,
      awbCode: `FAKEAWB${request.requestId}`,
      labelUrl: `https://fake-shipping.test/labels/${request.requestId}.pdf`,
      courierName: "FAKE-COURIER",
    })),
    requestCancellation: vi.fn(async () => ({
      status: ShippingProviderStatus.CANCELLATION_REQUESTED as const,
    })),
    readInboundEnvelope: vi.fn(),
    verifyInbound: vi.fn(),
    ...overrides,
  };
}

describe("ShippingRequestService", () => {
  const prisma = {
    shippingConnection: { findFirst: vi.fn() },
    shippingOutboundRequest: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    shipment: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  };

  const fulfillmentService = {
    getById: vi.fn(),
    createShipment: vi.fn(),
  };

  const auditService = {
    recordEvent: vi.fn(),
  };

  let adapter: ShippingProviderAdapter;
  let service: ShippingRequestService;

  function fulfillment() {
    return {
      id: "fulfillment-1",
      tenantId: "tenant-1",
      storeId: "store-1",
      locationId: "location-1",
      status: "IN_PROGRESS",
      order: { orderNumber: "#1001", createdAt: new Date("2026-10-09T00:00:00.000Z") },
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
    service = new ShippingRequestService(
      prisma as never,
      fulfillmentService as never,
      auditService as never,
      [adapter],
    );

    fulfillmentService.getById.mockResolvedValue(fulfillment());
    fulfillmentService.createShipment.mockResolvedValue({
      id: "shipment-1",
      items: [],
    });
    prisma.shippingConnection.findFirst.mockResolvedValue({
      id: "connection-1",
      tenantId: "tenant-1",
      provider: ShippingProvider.FAKE,
      externalAccountId: "acct-1",
      status: StoreConnectionStatus.ACTIVE,
    });
    prisma.shippingOutboundRequest.findUnique.mockResolvedValue(null);
    prisma.shippingOutboundRequest.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: "request-1",
        status: ShippingRequestStatus.PENDING,
        externalRequestId: null,
        shipmentId: (data as { shipmentId?: string }).shipmentId ?? null,
        ...(data as object),
      }),
    );
    prisma.shippingOutboundRequest.update.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: "request-1",
        status: data.status ?? ShippingRequestStatus.PENDING,
        externalRequestId:
          (data.externalRequestId as string | null | undefined) ?? null,
        responseJson: data.responseJson ?? null,
      }),
    );
    prisma.shipment.findFirst.mockResolvedValue(null);
    prisma.shipment.update.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: "shipment-1",
        ...(data as object),
      }),
    );
  });

  it("creates exactly one provider shipment per fulfillment, idempotently", async () => {
    const result = await service.createShipmentForFulfillment({
      tenantId: "tenant-1",
      storeId: "store-1",
      fulfillmentId: "fulfillment-1",
    });

    expect(result).toMatchObject({
      requestId: "request-1",
      shipmentId: "shipment-1",
      status: ShippingRequestStatus.SUCCEEDED,
      externalShipmentId: "fake-ship-ship-fulfillment-1",
      awbCode: "FAKEAWBship-fulfillment-1",
    });

    expect(fulfillmentService.createShipment).toHaveBeenCalledTimes(1);
    expect(adapter.createShipment).toHaveBeenCalledTimes(1);

    const command = (adapter.createShipment as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as { requestId: string; contractVersion: string };

    expect(command.contractVersion).toBe(SHIPPING_CONTRACT_VERSION);
    expect(command.requestId).toBe("ship-fulfillment-1");

    // Provider artifacts are bookkeeping only — the shipment's status is
    // never touched by the outbound side.
    const shipmentUpdate = (prisma.shipment.update as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as { data: Record<string, unknown> };
    expect(shipmentUpdate.data.status).toBeUndefined();
    expect(shipmentUpdate.data.externalShipmentId).toBe("fake-ship-ship-fulfillment-1");

    // Second submit: the SUCCEEDED anchor short-circuits — no second
    // provider request and no second canonical shipment.
    prisma.shippingOutboundRequest.findUnique.mockResolvedValue({
      id: "request-1",
      status: ShippingRequestStatus.SUCCEEDED,
      shipmentId: "shipment-1",
      externalRequestId: "fake-ship-ship-fulfillment-1",
      responseJson: { awbCode: "FAKEAWBship-fulfillment-1", labelUrl: "L" },
    });

    const again = await service.createShipmentForFulfillment({
      tenantId: "tenant-1",
      storeId: "store-1",
      fulfillmentId: "fulfillment-1",
    });

    expect(again.status).toBe(ShippingRequestStatus.SUCCEEDED);
    expect(fulfillmentService.createShipment).toHaveBeenCalledTimes(1);
    expect(adapter.createShipment).toHaveBeenCalledTimes(1);
  });

  it("retries a failed submit with the SAME idempotency key without duplicating the shipment", async () => {
    adapter = makeAdapter({
      createShipment: vi
        .fn()
        .mockRejectedValueOnce(new ShippingProviderError("TIMEOUT", "timed out"))
        .mockResolvedValueOnce({
          externalShipmentId: "fake-ship-ship-fulfillment-1",
          awbCode: "FAKEAWBship-fulfillment-1",
        }),
    });

    service = new ShippingRequestService(
      prisma as never,
      fulfillmentService as never,
      auditService as never,
      [adapter],
    );

    await expect(
      service.createShipmentForFulfillment({
        tenantId: "tenant-1",
        storeId: "store-1",
        fulfillmentId: "fulfillment-1",
      }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });

    // Failure is recorded on the anchor, not swallowed.
    const failUpdate = (prisma.shippingOutboundRequest.update as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as { data: Record<string, unknown> };
    expect(failUpdate.data.status).toBe(ShippingRequestStatus.FAILED);
    expect(failUpdate.data.lastError).toBe("timed out");
    expect(auditService.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "SHIPPING_SHIPMENT_REQUEST_FAILED" }),
    );

    // Retry resumes the SAME anchor + shipment (adopted from the crash window).
    prisma.shippingOutboundRequest.findUnique.mockResolvedValue({
      id: "request-1",
      status: ShippingRequestStatus.FAILED,
      shipmentId: "shipment-1",
      externalRequestId: null,
      responseJson: null,
    });

    const result = await service.createShipmentForFulfillment({
      tenantId: "tenant-1",
      storeId: "store-1",
      fulfillmentId: "fulfillment-1",
    });

    expect(result.status).toBe(ShippingRequestStatus.SUCCEEDED);
    expect(fulfillmentService.createShipment).toHaveBeenCalledTimes(1);
    expect(adapter.createShipment).toHaveBeenCalledTimes(2);

    const second = (adapter.createShipment as ReturnType<typeof vi.fn>).mock
      .calls[1]![0] as { requestId: string };
    expect(second.requestId).toBe("ship-fulfillment-1");
  });

  it("records a cancellation REQUEST as soft bookkeeping, never a status change", async () => {
    prisma.shipment.findFirst.mockResolvedValue({
      id: "shipment-1",
      tenantId: "tenant-1",
      storeId: "store-1",
      fulfillmentId: "fulfillment-1",
      status: ShipmentStatus.LABEL_CREATED,
      externalShipmentId: "ext-1",
      awbCode: "AWB-1",
      cancellationRequestedAt: null,
    });

    const result = await service.requestCancellation({
      tenantId: "tenant-1",
      storeId: "store-1",
      shipmentId: "shipment-1",
      reason: "customer changed mind",
    });

    expect(result).toMatchObject({
      requestId: "request-1",
      shipmentId: "shipment-1",
      status: ShippingRequestStatus.SUCCEEDED,
      providerStatus: ShippingProviderStatus.CANCELLATION_REQUESTED,
    });

    const shipmentUpdate = (prisma.shipment.update as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as { data: Record<string, unknown> };

    // Soft state: request bookkeeping only — status untouched.
    expect(shipmentUpdate.data.status).toBeUndefined();
    expect(shipmentUpdate.data.cancellationRequestedAt).toBeInstanceOf(Date);

    expect(auditService.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "SHIPPING_CANCELLATION_REQUESTED" }),
    );
  });

  it("refuses cancellation once the carrier has the parcel or it is already cancelled", async () => {
    for (const status of [ShipmentStatus.IN_TRANSIT, ShipmentStatus.DELIVERED]) {
      prisma.shipment.findFirst.mockResolvedValue({
        id: "shipment-1",
        tenantId: "tenant-1",
        storeId: "store-1",
        fulfillmentId: "fulfillment-1",
        status,
        externalShipmentId: "ext-1",
        cancellationRequestedAt: null,
      });

      await expect(
        service.requestCancellation({
          tenantId: "tenant-1",
          storeId: "store-1",
          shipmentId: "shipment-1",
        }),
      ).rejects.toThrow(UnprocessableEntityException);
    }

    prisma.shipment.findFirst.mockResolvedValue({
      id: "shipment-1",
      tenantId: "tenant-1",
      storeId: "store-1",
      fulfillmentId: "fulfillment-1",
      status: ShipmentStatus.CANCELLED,
      externalShipmentId: "ext-1",
      cancellationRequestedAt: new Date(),
    });

    await expect(
      service.requestCancellation({
        tenantId: "tenant-1",
        storeId: "store-1",
        shipmentId: "shipment-1",
      }),
    ).rejects.toThrow(UnprocessableEntityException);

    expect(adapter.requestCancellation).not.toHaveBeenCalled();
  });

  it("rejects submissions without an active connection or without items", async () => {
    prisma.shippingConnection.findFirst.mockResolvedValue(null);

    await expect(
      service.createShipmentForFulfillment({
        tenantId: "tenant-1",
        storeId: "store-1",
        fulfillmentId: "fulfillment-1",
      }),
    ).rejects.toThrow(UnprocessableEntityException);

    prisma.shippingConnection.findFirst.mockResolvedValue({
      id: "connection-1",
      tenantId: "tenant-1",
      provider: ShippingProvider.FAKE,
      status: StoreConnectionStatus.ACTIVE,
    });

    fulfillmentService.getById.mockResolvedValue({ ...fulfillment(), items: [] });

    await expect(
      service.createShipmentForFulfillment({
        tenantId: "tenant-1",
        storeId: "store-1",
        fulfillmentId: "fulfillment-1",
      }),
    ).rejects.toThrow(UnprocessableEntityException);
  });
});

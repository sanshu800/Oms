import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@prisma/client", () => import("../../test-utils/prisma-client.mock"));

import { ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { Prisma, WebhookStatus } from "@prisma/client";

import { encryptSecret } from "../shopify/shopify-auth.crypto";

import {
  SHIPPING_CONTRACT_VERSION,
  ShippingCapability,
  ShippingInboundEnvelope,
  ShippingProvider,
  ShippingProviderAdapter,
  ShippingProviderStatus,
  ShippingWireEventType,
} from "./shipping-contract";
import { ShippingEventIntakeService } from "./shipping-event-intake.service";

const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";

function makeAdapter(overrides: Partial<ShippingProviderAdapter> = {}): ShippingProviderAdapter {
  return {
    provider: ShippingProvider.FAKE,
    contractVersion: SHIPPING_CONTRACT_VERSION,
    capabilities: [ShippingCapability.SHIPMENT_CREATE],
    createShipment: vi.fn(),
    requestCancellation: vi.fn(),
    readInboundEnvelope: vi.fn(),
    verifyInbound: vi.fn(() => true),
    ...overrides,
  };
}

function envelope(): ShippingInboundEnvelope {
  return {
    externalAccountId: "acct-1",
    externalEventId: "se-1",
    event: {
      contractVersion: SHIPPING_CONTRACT_VERSION,
      type: ShippingWireEventType.TRACKING_UPDATED,
      externalEventId: "se-1",
      externalShipmentId: "ext-1",
      status: ShippingProviderStatus.IN_TRANSIT,
      occurredAt: "2026-10-09T10:00:00.000Z",
    },
  };
}

function payload(): Prisma.InputJsonValue {
  return {
    contractVersion: SHIPPING_CONTRACT_VERSION,
    type: "shipping.tracking.updated",
    externalEventId: "se-1",
    externalShipmentId: "ext-1",
    status: "in_transit",
    occurredAt: "2026-10-09T10:00:00.000Z",
  } as Prisma.InputJsonValue;
}

describe("ShippingEventIntakeService", () => {
  const prisma = {
    runAsSystem: vi.fn(async (fn: () => unknown) => fn()),
    shippingConnection: { findMany: vi.fn() },
    shippingEvent: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  };

  const queue = {
    enqueue: vi.fn(),
    requeue: vi.fn(),
  };

  let adapter: ShippingProviderAdapter;
  let service: ShippingEventIntakeService;

  beforeEach(() => {
    vi.clearAllMocks();

    adapter = makeAdapter();
    service = new ShippingEventIntakeService(prisma as never, queue);

    prisma.shippingConnection.findMany.mockResolvedValue([
      {
        id: "connection-1",
        tenantId: "tenant-1",
        provider: ShippingProvider.FAKE,
        externalAccountId: "acct-1",
        encryptedWebhookSecret: encryptSecret("hook-secret", ENCRYPTION_KEY),
      },
    ]);

    prisma.shippingEvent.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: "event-1",
        status: WebhookStatus.RECEIVED,
        ...(data as object),
      }),
    );
    prisma.shippingEvent.update.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: "event-1",
        ...(data as object),
      }),
    );
  });

  const delivery = () => ({
    adapter,
    envelope: envelope(),
    headers: {} as Record<string, string | string[] | undefined>,
    payload: payload(),
    payloadSha256: "sha",
    rawBody: Buffer.from("{}", "utf8"),
  });

  it("authenticates before storing, then stores before queueing", async () => {
    const recorded = await service.recordAndQueue(delivery());

    expect(recorded).toEqual({
      shippingEventId: "event-1",
      shouldEnqueue: true,
      resetForRetry: false,
    });

    expect(adapter.verifyInbound).toHaveBeenCalledTimes(1);
    expect(prisma.shippingEvent.create).toHaveBeenCalledTimes(1);
    expect(queue.enqueue).toHaveBeenCalledWith("event-1");
  });

  it("rejects unauthenticated deliveries WITHOUT storing them", async () => {
    adapter = makeAdapter({ verifyInbound: vi.fn(() => false) });
    service = new ShippingEventIntakeService(prisma as never, queue);

    await expect(service.recordAndQueue(delivery())).rejects.toThrow(
      UnauthorizedException,
    );

    expect(prisma.shippingEvent.create).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("rejects payloads without a type", async () => {
    await expect(
      service.recordAndQueue({
        ...delivery(),
        payload: { noType: true } as Prisma.InputJsonValue,
      }),
    ).rejects.toThrow(UnauthorizedException);

    expect(prisma.shippingEvent.create).not.toHaveBeenCalled();
  });

  it("acks duplicate deliveries without re-queueing or re-applying", async () => {
    prisma.shippingEvent.create.mockRejectedValueOnce(
      Object.assign(new Error("unique"), { code: "P2002" }),
    );
    prisma.shippingEvent.findUnique.mockResolvedValue({
      id: "event-1",
      status: WebhookStatus.PROCESSED,
    });

    const recorded = await service.recordAndQueue(delivery());

    expect(recorded).toEqual({
      shippingEventId: "event-1",
      shouldEnqueue: false,
      resetForRetry: false,
    });
    expect(queue.enqueue).not.toHaveBeenCalled();

    // PROCESSING / DEAD_LETTER duplicates are equally inert.
    for (const status of [WebhookStatus.PROCESSING, WebhookStatus.DEAD_LETTER]) {
      prisma.shippingEvent.create.mockRejectedValueOnce(
        Object.assign(new Error("unique"), { code: "P2002" }),
      );
      prisma.shippingEvent.findUnique.mockResolvedValue({
        id: "event-1",
        status,
      });

      const again = await service.recordAndQueue(delivery());
      expect(again.shouldEnqueue).toBe(false);
    }

    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("resets FAILED events for exactly one re-enqueue", async () => {
    prisma.shippingEvent.create.mockRejectedValueOnce(
      Object.assign(new Error("unique"), { code: "P2002" }),
    );
    prisma.shippingEvent.findUnique.mockResolvedValue({
      id: "event-1",
      status: WebhookStatus.FAILED,
    });

    const recorded = await service.recordAndQueue(delivery());

    expect(recorded).toEqual({
      shippingEventId: "event-1",
      shouldEnqueue: true,
      resetForRetry: true,
    });
    expect(prisma.shippingEvent.update).toHaveBeenCalledWith({
      where: { id: "event-1" },
      data: { status: WebhookStatus.RECEIVED },
    });
    expect(queue.requeue).toHaveBeenCalledWith("event-1");
  });

  it("stores durably and answers 503 when the queue is unreachable", async () => {
    queue.enqueue.mockRejectedValueOnce(new Error("redis down"));

    await expect(service.recordAndQueue(delivery())).rejects.toThrow(
      ServiceUnavailableException,
    );

    // The row exists (delivery is not lost) and is marked FAILED.
    expect(prisma.shippingEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.shippingEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "event-1" },
        data: expect.objectContaining({ status: WebhookStatus.FAILED }),
      }),
    );
  });
});

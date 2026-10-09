import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@prisma/client", () => import("../../test-utils/prisma-client.mock"));

import { UnauthorizedException } from "@nestjs/common";
import { WmsProvider } from "@prisma/client";

import { encryptSecret } from "../shopify/shopify-auth.crypto";
import { FakeWmsAdapter } from "./fake/fake-wms.adapter";
import { WmsEventIntakeService } from "./wms-event-intake.service";

const TEST_ENCRYPTION_KEY = "test-encryption-key-for-wms-secrets";
const SECRET = "wms-secret-1";

function delivery(event: Record<string, unknown> = {}) {
  return FakeWmsAdapter.buildSignedDelivery({
    secret: SECRET,
    externalWarehouseId: "wh-1",
    event: {
      eventType: "fulfillment.acknowledged",
      externalEventId: "wms-ev-1",
      requestRef: "fulfillment-1",
      occurredAt: "2026-10-09T10:05:00.000Z",
      ...event,
    },
  });
}

describe("WmsEventIntakeService", () => {
  const prisma = {
    runAsSystem: vi.fn(async (fn: () => unknown) => fn()),
    wmsConnection: { findMany: vi.fn() },
    wmsEvent: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  };

  const queue = {
    enqueue: vi.fn(),
    requeue: vi.fn(),
  };

  let adapter: FakeWmsAdapter;
  let service: WmsEventIntakeService;

  function record(overrides: { signature?: string; headers?: Record<string, string> } = {}) {
    const base = delivery();
    const headers = overrides.headers ?? {
      ...base.headers,
      ...(overrides.signature
        ? { "x-wms-signature": overrides.signature }
        : {}),
    };

    return service.recordDelivery({
      adapter,
      envelope: { externalWarehouseId: "wh-1", externalEventId: "wms-ev-1" },
      headers,
      payload: base.payload as never,
      payloadSha256: "sha",
      rawBody: base.rawBody,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();

    adapter = new FakeWmsAdapter({
      get: vi.fn((key: string) =>
        key === "ENCRYPTION_KEY" ? TEST_ENCRYPTION_KEY : undefined,
      ),
    } as never);

    service = new WmsEventIntakeService(prisma as never, queue as never);

    prisma.wmsConnection.findMany.mockResolvedValue([
      {
        id: "connection-1",
        tenantId: "tenant-1",
        provider: WmsProvider.FAKE,
        externalWarehouseId: "wh-1",
        encryptedWebhookSecret: encryptSecret(SECRET, TEST_ENCRYPTION_KEY),
      },
    ]);

    prisma.wmsEvent.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: "event-1",
        ...data,
      }),
    );
  });

  it("stores a verified delivery durably and enqueues it", async () => {
    const recorded = await record();

    expect(recorded).toEqual({
      wmsEventId: "event-1",
      shouldEnqueue: true,
      resetForRetry: false,
    });

    expect(prisma.wmsEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: "tenant-1",
          connectionId: "connection-1",
          externalEventId: "wms-ev-1",
          eventType: "fulfillment.acknowledged",
          payloadSha256: "sha",
        }),
      }),
    );
  });

  it("rejects forged deliveries WITHOUT storing them", async () => {
    await expect(record({ signature: "deadbeef" })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(prisma.wmsEvent.create).not.toHaveBeenCalled();
  });

  it("rejects deliveries for unknown warehouses without storing them", async () => {
    prisma.wmsConnection.findMany.mockResolvedValue([]);

    await expect(record()).rejects.toBeInstanceOf(UnauthorizedException);

    expect(prisma.wmsEvent.create).not.toHaveBeenCalled();
  });

  it("picks the connection whose secret verifies among same-identity candidates", async () => {
    prisma.wmsConnection.findMany.mockResolvedValue([
      {
        id: "connection-other",
        tenantId: "tenant-2",
        provider: WmsProvider.FAKE,
        externalWarehouseId: "wh-1",
        encryptedWebhookSecret: encryptSecret(
          "other-secret",
          TEST_ENCRYPTION_KEY,
        ),
      },
      {
        id: "connection-1",
        tenantId: "tenant-1",
        provider: WmsProvider.FAKE,
        externalWarehouseId: "wh-1",
        encryptedWebhookSecret: encryptSecret(SECRET, TEST_ENCRYPTION_KEY),
      },
    ]);

    await record();

    expect(prisma.wmsEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: "tenant-1",
          connectionId: "connection-1",
        }),
      }),
    );
  });

  it("acknowledges duplicate deliveries without re-queueing (durable idempotency)", async () => {
    const duplicate = {
      id: "event-1",
      status: "PROCESSED",
    };

    prisma.wmsEvent.create.mockRejectedValue({ code: "P2002" });
    prisma.wmsEvent.findUnique.mockResolvedValue(duplicate);

    const recorded = await record();

    expect(recorded).toEqual({
      wmsEventId: "event-1",
      shouldEnqueue: false,
      resetForRetry: false,
    });
  });

  it("resets a failed event for retry on redelivery", async () => {
    prisma.wmsEvent.create.mockRejectedValue({ code: "P2002" });
    prisma.wmsEvent.findUnique.mockResolvedValue({
      id: "event-1",
      status: "FAILED",
    });

    const recorded = await record();

    expect(recorded).toEqual({
      wmsEventId: "event-1",
      shouldEnqueue: true,
      resetForRetry: true,
    });

    expect(prisma.wmsEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "RECEIVED" },
      }),
    );
  });

  it("answer 503 when queueing fails, leaving the durable row intact", async () => {
    queue.enqueue.mockRejectedValue(new Error("Redis connection refused"));

    await expect(
      service.recordAndQueue({
        adapter,
        envelope: { externalWarehouseId: "wh-1", externalEventId: "wms-ev-1" },
        headers: delivery().headers,
        payload: delivery().payload as never,
        payloadSha256: "sha",
        rawBody: delivery().rawBody,
      }),
    ).rejects.toThrow("WMS event stored but not queued");

    expect(prisma.wmsEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          lastError: expect.stringContaining("Redis connection refused"),
        }),
      }),
    );
  });
});

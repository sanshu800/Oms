import { describe, expect, it, vi } from "vitest";

vi.mock("@prisma/client", () => import("../../../test-utils/prisma-client.mock"));

import { UnauthorizedException } from "@nestjs/common";

import { encryptSecret } from "../../shopify/shopify-auth.crypto";
import { FakeWmsAdapter } from "./fake-wms.adapter";
import { WMS_CONTRACT_VERSION, WmsSubmitFulfillmentRequestCommand } from "../wms-contract";

const TEST_ENCRYPTION_KEY = "test-encryption-key-for-wms-secrets";

function makeAdapter(configValues: Record<string, unknown> = {}) {
  return new FakeWmsAdapter({
    get: vi.fn((key: string) => configValues[key]),
  } as never);
}

function command(
  overrides: Partial<WmsSubmitFulfillmentRequestCommand> = {},
): WmsSubmitFulfillmentRequestCommand {
  return {
    contractVersion: WMS_CONTRACT_VERSION,
    idempotencyKey: "fulfillment-1",
    externalWarehouseId: "wh-1",
    request: {
      requestRef: "fulfillment-1",
      orderReference: "#1001",
      requestedAt: "2026-10-09T10:00:00.000Z",
      lines: [{ externalLineRef: "line-1", sku: "SKU-1", quantity: 3 }],
    },
    ...overrides,
  };
}

describe("FakeWmsAdapter.submitFulfillmentRequest", () => {
  it("assigns a deterministic request id derived from the idempotency key", async () => {
    const adapter = makeAdapter();

    const result = await adapter.submitFulfillmentRequest(command());

    expect(result.externalRequestId).toBe("fake-wms-fulfillment-1");
  });

  it("is idempotent on the idempotency key — one warehouse request, ever", async () => {
    const adapter = makeAdapter();

    const first = await adapter.submitFulfillmentRequest(command());
    const second = await adapter.submitFulfillmentRequest(command());
    const third = await adapter.submitFulfillmentRequest(command());

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(adapter.warehouseRequestCount).toBe(1);
  });

  it("rejects contract version mismatches instead of half-understanding", async () => {
    const adapter = makeAdapter();

    await expect(
      adapter.submitFulfillmentRequest(
        command({ contractVersion: "0.9" }),
      ),
    ).rejects.toThrow("WMS contract version mismatch");
  });

  it("validates lines before anything reaches the warehouse", async () => {
    const adapter = makeAdapter();

    await expect(
      adapter.submitFulfillmentRequest(command({
        request: {
          requestRef: "fulfillment-1",
          orderReference: "#1001",
          requestedAt: "2026-10-09T10:00:00.000Z",
          lines: [],
        },
      })),
    ).rejects.toThrow("at least one line");

    await expect(
      adapter.submitFulfillmentRequest(command({
        request: {
          requestRef: "fulfillment-1",
          orderReference: "#1001",
          requestedAt: "2026-10-09T10:00:00.000Z",
          lines: [{ externalLineRef: "line-1", sku: "SKU-1", quantity: 0 }],
        },
      })),
    ).rejects.toThrow("invalid quantity");
  });

  it("supports deterministic failure injection for retry tests", async () => {
    const adapter = makeAdapter();

    adapter.failNextSubmit("warehouse unavailable");

    await expect(
      adapter.submitFulfillmentRequest(command()),
    ).rejects.toThrow("warehouse unavailable");

    // The failure is one-shot; the retry (same key) succeeds and still
    // produces exactly one warehouse request.
    const result = await adapter.submitFulfillmentRequest(command());

    expect(result.externalRequestId).toBe("fake-wms-fulfillment-1");
    expect(adapter.warehouseRequestCount).toBe(1);
  });
});

describe("FakeWmsAdapter inbound verification", () => {
  const secret = "wms-secret-1";

  function delivery(event: Record<string, unknown> = {}) {
    return FakeWmsAdapter.buildSignedDelivery({
      secret,
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

  const encryptedWebhookSecret = encryptSecret(secret, TEST_ENCRYPTION_KEY);

  function verifyInput(overrides: {
    rawBody?: Buffer;
    headers?: Record<string, string>;
  } = {}) {
    const base = delivery();

    return {
      rawBody: overrides.rawBody ?? base.rawBody,
      headers: overrides.headers ?? base.headers,
      envelope: {
        externalWarehouseId: "wh-1",
        externalEventId: "wms-ev-1",
      },
      connection: {
        id: "connection-1",
        encryptedWebhookSecret,
      },
    };
  }

  it("accepts a correctly signed delivery", async () => {
    const adapter = makeAdapter({ ENCRYPTION_KEY: TEST_ENCRYPTION_KEY });

    await expect(
      adapter.verifyInbound(verifyInput()),
    ).resolves.toBeUndefined();
  });

  it("rejects forged and missing signatures before anything is stored", async () => {
    const adapter = makeAdapter({ ENCRYPTION_KEY: TEST_ENCRYPTION_KEY });

    const forged = delivery();
    forged.headers["x-wms-signature"] = "deadbeef";

    await expect(
      adapter.verifyInbound(verifyInput({ headers: forged.headers })),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    const unsigned = delivery();
    delete unsigned.headers["x-wms-signature"];

    await expect(
      adapter.verifyInbound(verifyInput({ headers: unsigned.headers })),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    // Signature over different bytes must not verify.
    await expect(
      adapter.verifyInbound(
        verifyInput({ rawBody: Buffer.from("{}", "utf8") }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("refuses to verify without a connection secret (no env fallback)", async () => {
    const adapter = makeAdapter({ ENCRYPTION_KEY: TEST_ENCRYPTION_KEY });

    await expect(
      adapter.verifyInbound({
        ...verifyInput(),
        connection: { id: "connection-1", encryptedWebhookSecret: null },
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("extracts the delivery identity from provider headers", () => {
    const adapter = makeAdapter();
    const { headers } = delivery();

    expect(adapter.readInboundEnvelope(headers)).toEqual({
      externalWarehouseId: "wh-1",
      externalEventId: "wms-ev-1",
    });

    expect(() =>
      adapter.readInboundEnvelope({ "x-wms-event-id": "x" }),
    ).toThrow("Required WMS webhook headers are missing");
  });
});

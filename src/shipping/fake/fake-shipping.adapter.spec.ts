import { describe, expect, it, vi } from "vitest";

vi.mock("@prisma/client", () => import("../../../test-utils/prisma-client.mock"));

import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ShippingProvider } from "@prisma/client";

import { encryptSecret } from "../../shopify/shopify-auth.crypto";
import {
  SHIPPING_CONTRACT_VERSION,
  ShippingCapability,
  ShippingProviderError,
  ShippingProviderStatus,
} from "../shipping-contract";

import { FakeShippingProviderAdapter } from "./fake-shipping.adapter";

function makeAdapter(encryptionKey = "0123456789abcdef0123456789abcdef") {
  const config = {
    get: vi.fn((key: string) => (key === "ENCRYPTION_KEY" ? encryptionKey : undefined)),
  } as unknown as ConfigService;

  return new FakeShippingProviderAdapter(config);
}

const createRequest = (requestId = "ship-1") => ({
  requestId,
  fulfillmentId: "fulfillment-1",
  shipmentId: "shipment-1",
  order: {
    externalOrderNumber: "#1001",
    orderDate: "2026-10-09T00:00:00.000Z",
    paymentMethod: "PREPAID" as const,
  },
  deliveryAddress: {
    name: "A",
    address: "B",
    city: "C",
    state: "D",
    pincode: "123456",
    country: "IN",
  },
  items: [{ sku: "SKU-1", name: "Item", units: 1, sellingPrice: "10.00" }],
  dimensions: { length: 1, breadth: 1, height: 1, weight: 1 },
});

describe("FakeShippingProviderAdapter", () => {
  it("pins its identity and honest capabilities", () => {
    const adapter = makeAdapter();

    expect(adapter.provider).toBe(ShippingProvider.FAKE);
    expect(adapter.contractVersion).toBe(SHIPPING_CONTRACT_VERSION);
    expect([...adapter.capabilities]).toEqual([
      ShippingCapability.SHIPMENT_CREATE,
      ShippingCapability.SHIPMENT_CANCEL,
      ShippingCapability.LABEL_FETCH,
      ShippingCapability.TRACKING_QUERY,
    ]);
  });

  it("creates shipments deterministically and idempotently", async () => {
    const adapter = makeAdapter();

    const first = await adapter.createShipment(createRequest());
    const second = await adapter.createShipment(createRequest());

    expect(first.externalShipmentId).toBe("fake-ship-ship-1");
    expect(first.awbCode).toBe("FAKEAWBship-1");
    expect(first.labelUrl).toBe("https://fake-shipping.test/labels/ship-1.pdf");
    expect(second.externalShipmentId).toBe(first.externalShipmentId);
    expect(adapter.carrierShipmentCount).toBe(1);
  });

  it("injects one-shot timeouts and upstream failures", async () => {
    const adapter = makeAdapter();

    adapter.timeoutNextCreate();

    await expect(adapter.createShipment(createRequest())).rejects.toMatchObject({
      name: "ShippingProviderError",
      code: "TIMEOUT",
    });

    // Consumed: the next create succeeds with the same deterministic id.
    const result = await adapter.createShipment(createRequest());
    expect(result.externalShipmentId).toBe("fake-ship-ship-1");

    adapter.failNextCreate("courier unavailable", "UPSTREAM_ERROR");

    await expect(adapter.createShipment(createRequest("ship-2"))).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
      message: "courier unavailable",
    });

    await expect(adapter.createShipment(createRequest("ship-2"))).resolves.toMatchObject({
      externalShipmentId: "fake-ship-ship-2",
    });
  });

  it("returns cancellation_requested by default and cancelled only when configured", async () => {
    const adapter = makeAdapter();

    await adapter.createShipment(createRequest());

    const requested = await adapter.requestCancellation({
      requestId: "cancel-1",
      externalShipmentId: "fake-ship-ship-1",
    });

    // The soft state — never silently "cancelled".
    expect(requested.status).toBe(ShippingProviderStatus.CANCELLATION_REQUESTED);

    adapter.timeoutNextCancel();

    await expect(
      adapter.requestCancellation({ requestId: "cancel-1", externalShipmentId: "fake-ship-ship-1" }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });

    adapter.confirmNextCancellation();

    const confirmed = await adapter.requestCancellation({
      requestId: "cancel-1",
      externalShipmentId: "fake-ship-ship-1",
    });

    expect(confirmed.status).toBe(ShippingProviderStatus.CANCELLED);

    // Idempotent: a repeat of the confirmed cancellation stays confirmed.
    const again = await adapter.requestCancellation({
      requestId: "cancel-1",
      externalShipmentId: "fake-ship-ship-1",
    });

    expect(again.status).toBe(ShippingProviderStatus.CANCELLED);
  });

  it("rejects invalid create requests with typed provider errors", async () => {
    const adapter = makeAdapter();

    await expect(
      adapter.createShipment({ ...createRequest(), items: [] }),
    ).rejects.toBeInstanceOf(ShippingProviderError);

    await expect(
      adapter.createShipment({
        ...createRequest(),
        items: [{ sku: "SKU-1", name: "Item", units: 0, sellingPrice: "1.00" }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("verifies inbound signatures against the per-connection secret", () => {
    const adapter = makeAdapter();
    const secret = "webhook-secret-1";
    const encryptedWebhookSecret = encryptSecret(secret, "0123456789abcdef0123456789abcdef");

    const delivery = FakeShippingProviderAdapter.buildSignedDelivery({
      secret,
      externalAccountId: "acct-1",
      event: {
        contractVersion: SHIPPING_CONTRACT_VERSION,
        type: "shipping.tracking.updated",
        externalEventId: "se-1",
        externalShipmentId: "ext-1",
        status: "in_transit",
        occurredAt: "2026-10-09T10:00:00.000Z",
      },
    });

    const envelope = adapter.readInboundEnvelope({
      headers: delivery.headers,
      rawBody: delivery.rawBody,
    });

    expect(envelope.externalAccountId).toBe("acct-1");
    expect(envelope.externalEventId).toBe("se-1");
    expect(envelope.event.type).toBe("shipping.tracking.updated");
    expect(envelope.event.status).toBe("in_transit");

    expect(
      adapter.verifyInbound({
        rawBody: delivery.rawBody,
        headers: delivery.headers,
        envelope,
        connection: { id: "conn-1", encryptedWebhookSecret },
      }),
    ).toBe(true);

    // Tampered body fails.
    const tampered = Buffer.from(delivery.rawBody.toString("utf8").replace("in_transit", "delivered"), "utf8");

    expect(
      adapter.verifyInbound({
        rawBody: tampered,
        headers: delivery.headers,
        envelope,
        connection: { id: "conn-1", encryptedWebhookSecret },
      }),
    ).toBe(false);

    // No secret configured -> operational error, not a silent pass.
    expect(() =>
      adapter.verifyInbound({
        rawBody: delivery.rawBody,
        headers: delivery.headers,
        envelope,
        connection: { id: "conn-1", encryptedWebhookSecret: null },
      }),
    ).toThrow(UnauthorizedException);
  });

  it("rejects malformed deliveries at the envelope", () => {
    const adapter = makeAdapter();

    expect(() =>
      adapter.readInboundEnvelope({
        headers: {},
        rawBody: Buffer.from("{}", "utf8"),
      }),
    ).toThrow(BadRequestException);

    expect(() =>
      adapter.readInboundEnvelope({
        headers: {
          "x-shipping-account-id": "acct-1",
          "x-shipping-event-id": "se-1",
        },
        rawBody: Buffer.from("not-json", "utf8"),
      }),
    ).toThrow(BadRequestException);

    expect(() =>
      adapter.readInboundEnvelope({
        headers: {
          "x-shipping-account-id": "acct-1",
          "x-shipping-event-id": "se-1",
        },
        rawBody: Buffer.from(JSON.stringify({ type: "", externalShipmentId: "" }), "utf8"),
      }),
    ).toThrow(BadRequestException);
  });

  it("fetches labels and tracking deterministically", async () => {
    const adapter = makeAdapter();

    await adapter.createShipment(createRequest());

    await expect(
      adapter.fetchLabel!({ externalShipmentId: "fake-ship-ship-1" }),
    ).resolves.toEqual({ labelUrl: "https://fake-shipping.test/labels/ship-1.pdf" });

    adapter.setTrackingStatus("fake-ship-ship-1", ShippingProviderStatus.DELIVERED);

    await expect(
      adapter.fetchTracking!({ externalShipmentId: "fake-ship-ship-1" }),
    ).resolves.toMatchObject({ currentStatus: ShippingProviderStatus.DELIVERED });

    await expect(
      adapter.fetchLabel!({ externalShipmentId: "missing" }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});

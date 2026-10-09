import { describe, expect, it } from "vitest";

import {
  SHIPPING_CONTRACT_VERSION,
  SHIPPING_STATUS_DESCRIPTIONS,
  ShippingCapability,
  ShippingProvider,
  ShippingProviderStatus,
  ShippingWireEventType,
  doesStatusMarkHandover,
  isShippingAdapter,
} from "./shipping-contract";

describe("shipping contract v1.0 (pinned)", () => {
  it("pins the contract version", () => {
    expect(SHIPPING_CONTRACT_VERSION).toBe("1.0");
  });

  it("keeps cancellation_requested and cancelled as distinct statuses", () => {
    expect(ShippingProviderStatus.CANCELLATION_REQUESTED).not.toBe(ShippingProviderStatus.CANCELLED);
    expect(ShippingProviderStatus.CANCELLATION_REQUESTED).toBe("cancellation_requested");
    expect(ShippingProviderStatus.CANCELLED).toBe("cancelled");
  });

  it("has a distinct wire event for cancellation request vs confirmation", () => {
    expect(ShippingWireEventType.CANCELLATION_REQUESTED).toBe("shipping.cancellation.requested");
    expect(ShippingWireEventType.CANCELLATION_CONFIRMED).toBe("shipping.cancellation.confirmed");
    expect(ShippingWireEventType.CANCELLATION_REQUESTED).not.toBe(ShippingWireEventType.CANCELLATION_CONFIRMED);
  });

  it("defines handover strictly as courier possession", () => {
    expect(doesStatusMarkHandover(ShippingProviderStatus.IN_TRANSIT)).toBe(true);
    expect(doesStatusMarkHandover(ShippingProviderStatus.OUT_FOR_DELIVERY)).toBe(true);
    expect(doesStatusMarkHandover(ShippingProviderStatus.DELIVERED)).toBe(true);
    expect(doesStatusMarkHandover(ShippingProviderStatus.RTO_IN_TRANSIT)).toBe(true);
    // Packing/AWB/label/pickup artifacts are NOT handover:
    expect(doesStatusMarkHandover(ShippingProviderStatus.PENDING)).toBe(false);
    expect(doesStatusMarkHandover(ShippingProviderStatus.AWB_ASSIGNED)).toBe(false);
    expect(doesStatusMarkHandover(ShippingProviderStatus.PICKUP_SCHEDULED)).toBe(false);
    // Cancellation states are not handover either:
    expect(doesStatusMarkHandover(ShippingProviderStatus.CANCELLATION_REQUESTED)).toBe(false);
    expect(doesStatusMarkHandover(ShippingProviderStatus.CANCELLED)).toBe(false);
  });

  it("describes every provider status, distinguishing request from confirmation", () => {
    for (const status of Object.values(ShippingProviderStatus)) {
      expect(SHIPPING_STATUS_DESCRIPTIONS[status]).toBeTruthy();
    }
    expect(SHIPPING_STATUS_DESCRIPTIONS[ShippingProviderStatus.CANCELLATION_REQUESTED]).toContain("NOT confirmed");
    expect(SHIPPING_STATUS_DESCRIPTIONS[ShippingProviderStatus.CANCELLED]).toContain("CONFIRMED");
    expect(SHIPPING_STATUS_DESCRIPTIONS[ShippingProviderStatus.AWB_ASSIGNED]).toContain("NOT shipped");
    expect(SHIPPING_STATUS_DESCRIPTIONS[ShippingProviderStatus.PICKUP_SCHEDULED]).toContain("NOT shipped");
  });

  it("ships the provider-neutral + Shiprocket provider enum values", () => {
    expect(ShippingProvider.FAKE).toBe("FAKE");
    expect(ShippingProvider.SHIPROCKET).toBe("SHIPROCKET");
  });

  it("covers the planned outbound capabilities", () => {
    expect(Object.values(ShippingCapability)).toEqual([
      "shipment.create",
      "shipment.cancel",
      "label.fetch",
      "tracking.query",
    ]);
  });

  it("structurally validates adapters (used by the adapter registry)", () => {
    expect(isShippingAdapter(null)).toBe(false);
    expect(isShippingAdapter({})).toBe(false);
    expect(
      isShippingAdapter({
        provider: ShippingProvider.SHIPROCKET,
        contractVersion: "1.0",
        capabilities: [ShippingCapability.SHIPMENT_CREATE],
        createShipment: async () => ({}),
        requestCancellation: async () => ({ status: "cancellation_requested" }),
        readInboundEnvelope: () => ({}),
        verifyInbound: () => true,
      }),
    ).toBe(true);
  });
});

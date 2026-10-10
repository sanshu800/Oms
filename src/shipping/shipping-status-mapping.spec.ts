import { describe, expect, it } from "vitest";

import {
  SHIPPING_CONTRACT_VERSION,
  ShippingInboundEvent,
  ShippingProviderStatus,
  ShippingWireEventType,
  doesStatusMarkHandover,
} from "./shipping-contract";
import {
  mapShiprocketActivityToShippingStatus,
  mapShippingEventToCanonicalAction,
} from "./shipping-status-mapping";

const baseEvent = (overrides: Partial<ShippingInboundEvent> = {}): ShippingInboundEvent => ({
  contractVersion: SHIPPING_CONTRACT_VERSION,
  type: ShippingWireEventType.TRACKING_UPDATED,
  externalEventId: "sre-1",
  externalShipmentId: "sr-shipment-1",
  status: ShippingProviderStatus.PENDING,
  occurredAt: "2026-10-09T10:00:00.000Z",
  ...overrides,
});

describe("mapShiprocketActivityToShippingStatus", () => {
  it("maps AWB/label/pickup artifacts to non-handover statuses", () => {
    expect(mapShiprocketActivityToShippingStatus("AWB Assigned")).toBe(ShippingProviderStatus.AWB_ASSIGNED);
    expect(mapShiprocketActivityToShippingStatus("LABEL GENERATED")).toBe(ShippingProviderStatus.AWB_ASSIGNED);
    expect(mapShiprocketActivityToShippingStatus("Pickup Scheduled")).toBe(ShippingProviderStatus.PICKUP_SCHEDULED);
    expect(mapShiprocketActivityToShippingStatus("Pickup Generated")).toBe(ShippingProviderStatus.PICKUP_SCHEDULED);
    expect(mapShiprocketActivityToShippingStatus("New")).toBe(ShippingProviderStatus.PENDING);
  });

  it("maps carrier movement and delivery activities", () => {
    expect(mapShiprocketActivityToShippingStatus("IN TRANSIT")).toBe(ShippingProviderStatus.IN_TRANSIT);
    expect(mapShiprocketActivityToShippingStatus("Picked Up")).toBe(ShippingProviderStatus.IN_TRANSIT);
    expect(mapShiprocketActivityToShippingStatus("Out For Delivery")).toBe(ShippingProviderStatus.OUT_FOR_DELIVERY);
    expect(mapShiprocketActivityToShippingStatus("Delivered")).toBe(ShippingProviderStatus.DELIVERED);
    expect(mapShiprocketActivityToShippingStatus("RTO In Transit")).toBe(ShippingProviderStatus.RTO_IN_TRANSIT);
    expect(mapShiprocketActivityToShippingStatus("Delivery Attempted")).toBe(ShippingProviderStatus.DELIVERY_FAILED);
    expect(mapShiprocketActivityToShippingStatus("Lost")).toBe(ShippingProviderStatus.LOST);
  });

  it("keeps cancellation request and confirmation distinct", () => {
    expect(mapShiprocketActivityToShippingStatus("Cancellation Requested")).toBe(
      ShippingProviderStatus.CANCELLATION_REQUESTED,
    );
    expect(mapShiprocketActivityToShippingStatus("Pickup Cancelled")).toBe(
      ShippingProviderStatus.CANCELLATION_REQUESTED,
    );
    expect(mapShiprocketActivityToShippingStatus("Cancelled")).toBe(ShippingProviderStatus.CANCELLED);
  });

  it("is case/whitespace-insensitive and maps unknown activities to UNKNOWN", () => {
    expect(mapShiprocketActivityToShippingStatus("  in   transit ")).toBe(ShippingProviderStatus.IN_TRANSIT);
    expect(mapShiprocketActivityToShippingStatus("Teleported")).toBe(ShippingProviderStatus.UNKNOWN);
    expect(mapShiprocketActivityToShippingStatus("")).toBe(ShippingProviderStatus.UNKNOWN);
  });
});

describe("mapShippingEventToCanonicalAction (contract-pinned)", () => {
  it("pins the contract version guard", () => {
    const action = mapShippingEventToCanonicalAction(baseEvent({ contractVersion: "99.0" }));
    expect(action).toEqual({
      type: "reject_event",
      externalShipmentId: "sr-shipment-1",
      reason: "Unsupported shipping contract version: 99.0",
    });
  });

  it("maps shipment creation without AWB to record_shipment_created", () => {
    const action = mapShippingEventToCanonicalAction(
      baseEvent({ type: ShippingWireEventType.SHIPMENT_CREATED, status: ShippingProviderStatus.PENDING }),
    );
    expect(action.type).toBe("record_shipment_created");
  });

  it("maps shipment creation carrying AWB/label to record_label_created (never shipped)", () => {
    const action = mapShippingEventToCanonicalAction(
      baseEvent({
        type: ShippingWireEventType.SHIPMENT_CREATED,
        status: ShippingProviderStatus.AWB_ASSIGNED,
        awbCode: "DLV987654321",
        labelUrl: "https://cdn.example/label.pdf",
      }),
    );
    expect(action).toEqual({
      type: "record_label_created",
      externalShipmentId: "sr-shipment-1",
      awbCode: "DLV987654321",
      labelUrl: "https://cdn.example/label.pdf",
    });
  });

  it("NEVER marks handover from AWB assignment, label generation, or pickup scheduling", () => {
    for (const status of [
      ShippingProviderStatus.PENDING,
      ShippingProviderStatus.AWB_ASSIGNED,
      ShippingProviderStatus.PICKUP_SCHEDULED,
    ]) {
      const action = mapShippingEventToCanonicalAction(baseEvent({ status }));
      expect(action.type).toBe("record_progress");
      expect(action.type).not.toBe("record_handover_confirmed");
      expect(doesStatusMarkHandover(status)).toBe(false);
    }
  });

  it("only carrier handover statuses produce record_handover_confirmed", () => {
    for (const status of [
      ShippingProviderStatus.IN_TRANSIT,
      ShippingProviderStatus.OUT_FOR_DELIVERY,
    ]) {
      const action = mapShippingEventToCanonicalAction(baseEvent({ status }));
      expect(action).toEqual({ type: "record_handover_confirmed", externalShipmentId: "sr-shipment-1" });
      expect(doesStatusMarkHandover(status)).toBe(true);
    }
    expect(doesStatusMarkHandover(ShippingProviderStatus.DELIVERED)).toBe(true);
    expect(doesStatusMarkHandover(ShippingProviderStatus.AWB_ASSIGNED)).toBe(false);
    expect(doesStatusMarkHandover(ShippingProviderStatus.PICKUP_SCHEDULED)).toBe(false);
    expect(doesStatusMarkHandover(ShippingProviderStatus.CANCELLATION_REQUESTED)).toBe(false);
    expect(doesStatusMarkHandover(ShippingProviderStatus.CANCELLED)).toBe(false);
  });

  it("maps delivery through the dedicated action", () => {
    const viaTracking = mapShippingEventToCanonicalAction(baseEvent({ status: ShippingProviderStatus.DELIVERED }));
    expect(viaTracking).toEqual({ type: "record_delivered", externalShipmentId: "sr-shipment-1" });

    const viaDeliveredEvent = mapShippingEventToCanonicalAction(
      baseEvent({ type: ShippingWireEventType.TRACKING_DELIVERED }),
    );
    expect(viaDeliveredEvent).toEqual({ type: "record_delivered", externalShipmentId: "sr-shipment-1" });
  });

  it("keeps cancellation REQUEST and CONFIRMATION as distinct actions", () => {
    const requestedViaStatus = mapShippingEventToCanonicalAction(
      baseEvent({ status: ShippingProviderStatus.CANCELLATION_REQUESTED }),
    );
    expect(requestedViaStatus).toEqual({
      type: "record_cancellation_requested",
      externalShipmentId: "sr-shipment-1",
    });

    const requestedViaEvent = mapShippingEventToCanonicalAction(
      baseEvent({ type: ShippingWireEventType.CANCELLATION_REQUESTED }),
    );
    expect(requestedViaEvent).toEqual({
      type: "record_cancellation_requested",
      externalShipmentId: "sr-shipment-1",
    });

    const confirmedViaStatus = mapShippingEventToCanonicalAction(
      baseEvent({ status: ShippingProviderStatus.CANCELLED }),
    );
    expect(confirmedViaStatus).toEqual({
      type: "record_cancellation_confirmed",
      externalShipmentId: "sr-shipment-1",
    });

    const confirmedViaEvent = mapShippingEventToCanonicalAction(
      baseEvent({ type: ShippingWireEventType.CANCELLATION_CONFIRMED }),
    );
    expect(confirmedViaEvent).toEqual({
      type: "record_cancellation_confirmed",
      externalShipmentId: "sr-shipment-1",
    });

    expect(requestedViaStatus.type).not.toBe(confirmedViaStatus.type);
  });

  it("rejects unknown statuses and unknown event types without mutations", () => {
    const unknownStatus = mapShippingEventToCanonicalAction(baseEvent({ status: ShippingProviderStatus.UNKNOWN }));
    expect(unknownStatus).toEqual({
      type: "reject_event",
      externalShipmentId: "sr-shipment-1",
      reason: "Unrecognized shipping status; no canonical transition applied",
    });

    const unknownType = mapShippingEventToCanonicalAction(
      baseEvent({ type: "shipping.made.up" as ShippingWireEventType }),
    );
    expect(unknownType.type).toBe("reject_event");
    expect(unknownType).toMatchObject({ externalShipmentId: "sr-shipment-1" });
    if (unknownType.type === "reject_event") {
      expect(unknownType.reason).toBe("Unknown shipping event type: shipping.made.up");
    }
  });
});

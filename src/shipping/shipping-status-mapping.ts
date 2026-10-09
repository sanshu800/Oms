import {
  SHIPPING_CONTRACT_VERSION,
  ShippingCanonicalAction,
  ShippingInboundEvent,
  ShippingProviderStatus,
  ShippingWireEventType,
  doesStatusMarkHandover,
} from "./shipping-contract";

/**
 * Pure shipping-provider status mapping. No I/O, no Nest, no Prisma.
 *
 * Contract invariants pinned by `shipping-status-mapping.spec.ts`:
 * - AWB assignment / label generation / pickup scheduling NEVER produce a
 *   handover action (an order can only be shipped by courier handover).
 * - `cancellation_requested` and `cancelled` map to two DIFFERENT actions.
 * - Unknown or non-shippable input maps to `reject_event` with a stable reason,
 *   never to a guessed transition.
 */

/**
 * Normalize Shiprocket tracking activity strings to the contract's provider
 * status enum. Matching is case/whitespace-insensitive; anything unrecognized
 * maps to UNKNOWN (the raw value is preserved by the event metadata).
 *
 * Known Shiprocket activities (public docs / tracking webhooks): NEW,
 * PICKUP SCHEDULED, PICKUP GENERATED, PICKUP CANCELLED, PICKUP MANIFESTED,
 * AWB ASSIGNED, LABEL GENERATED, IN TRANSIT, OUT FOR DELIVERY, DELIVERED,
 * DELIVERY ATTEMPTED, RTO IN TRANSIT, RTO DELIVERED, RTO INITIATED, LOST,
 * CANCELLED, and cancellation-request variants.
 */
export function mapShiprocketActivityToShippingStatus(activity: string): ShippingProviderStatus {
  const normalized = activity.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");

  switch (normalized) {
    case "new":
    case "order created":
    case "shipment created":
    case "pickup manifest generated":
      return ShippingProviderStatus.PENDING;
    case "awb assigned":
    case "label generated":
    case "pickup manifested":
      return ShippingProviderStatus.AWB_ASSIGNED;
    case "pickup scheduled":
    case "pickup generated":
    case "pickup data pushed":
      return ShippingProviderStatus.PICKUP_SCHEDULED;
    case "in transit":
    case "picked up":
    case "shipped":
      return ShippingProviderStatus.IN_TRANSIT;
    case "out for delivery":
      return ShippingProviderStatus.OUT_FOR_DELIVERY;
    case "delivered":
      return ShippingProviderStatus.DELIVERED;
    case "delivery attempted":
    case "undelivered":
    case "delivery failed":
      return ShippingProviderStatus.DELIVERY_FAILED;
    case "rto in transit":
    case "rto initiated":
      return ShippingProviderStatus.RTO_IN_TRANSIT;
    case "rto delivered":
      return ShippingProviderStatus.RTO_DELIVERED;
    case "cancellation requested":
    case "cancel requested":
    case "pickup cancelled":
      return ShippingProviderStatus.CANCELLATION_REQUESTED;
    case "cancelled":
    case "canceled":
      return ShippingProviderStatus.CANCELLED;
    case "lost":
      return ShippingProviderStatus.LOST;
    default:
      return ShippingProviderStatus.UNKNOWN;
  }
}

/**
 * The single sanctioned reducer: wire event -> canonical action.
 * Guarded by the contract version; unknown versions reject.
 */
export function mapShippingEventToCanonicalAction(event: ShippingInboundEvent): ShippingCanonicalAction {
  if (event.contractVersion !== SHIPPING_CONTRACT_VERSION) {
    return {
      type: "reject_event",
      externalShipmentId: event.externalShipmentId,
      reason: `Unsupported shipping contract version: ${String(event.contractVersion)}`,
    };
  }

  switch (event.type) {
    case ShippingWireEventType.SHIPMENT_CREATED: {
      // Creation may carry AWB/label artifacts; that stops at LABEL_CREATED.
      if (event.awbCode || event.labelUrl) {
        return {
          type: "record_label_created",
          externalShipmentId: event.externalShipmentId,
          awbCode: event.awbCode,
          labelUrl: event.labelUrl,
        };
      }
      return {
        type: "record_shipment_created",
        externalShipmentId: event.externalShipmentId,
        awbCode: event.awbCode,
        courierName: event.courierName,
        labelUrl: event.labelUrl,
      };
    }

    case ShippingWireEventType.TRACKING_UPDATED: {
      if (event.status === ShippingProviderStatus.UNKNOWN) {
        return {
          type: "reject_event",
          externalShipmentId: event.externalShipmentId,
          reason: "Unrecognized shipping status; no canonical transition applied",
        };
      }
      if (event.status === ShippingProviderStatus.CANCELLATION_REQUESTED) {
        return { type: "record_cancellation_requested", externalShipmentId: event.externalShipmentId };
      }
      if (event.status === ShippingProviderStatus.CANCELLED) {
        return { type: "record_cancellation_confirmed", externalShipmentId: event.externalShipmentId };
      }
      if (event.status === ShippingProviderStatus.DELIVERED) {
        return { type: "record_delivered", externalShipmentId: event.externalShipmentId };
      }
      if (doesStatusMarkHandover(event.status)) {
        // IN_TRANSIT / OUT_FOR_DELIVERY / RTO lineage: courier handover proof.
        return { type: "record_handover_confirmed", externalShipmentId: event.externalShipmentId };
      }
      // PENDING / AWB_ASSIGNED / PICKUP_SCHEDULED / DELIVERY_FAILED / LOST:
      // bookkeeping only — explicitly NEVER a handover.
      return {
        type: "record_progress",
        externalShipmentId: event.externalShipmentId,
        status: event.status,
      };
    }

    case ShippingWireEventType.TRACKING_DELIVERED:
      return { type: "record_delivered", externalShipmentId: event.externalShipmentId };

    case ShippingWireEventType.CANCELLATION_REQUESTED:
      return { type: "record_cancellation_requested", externalShipmentId: event.externalShipmentId };

    case ShippingWireEventType.CANCELLATION_CONFIRMED:
      return { type: "record_cancellation_confirmed", externalShipmentId: event.externalShipmentId };

    default: {
      const unknownType = (event as { type?: unknown }).type;
      return {
        type: "reject_event",
        externalShipmentId: event.externalShipmentId,
        reason: `Unknown shipping event type: ${String(unknownType)}`,
      };
    }
  }
}

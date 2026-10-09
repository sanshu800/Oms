/**
 * Shipping-Provider Integration Contract — v1.0
 * =============================================
 *
 * This contract is SEPARATE from the WMS contract (`src/wms/wms-contract.ts`, v1.0)
 * and from any specific provider implementation (Shiprocket is the first planned
 * provider; a `FAKE` provider exists for deterministic testing).
 *
 * STATE OWNERSHIP (authoritative)
 * --------------------------------
 * - The WMS owns warehouse-side facts: acknowledgement, picking, packing, and
 *   warehouse handover events (see the WMS contract). A WMS `fulfillment.shipped`
 *   event means the warehouse physically handed the parcel over.
 * - The shipping provider owns carrier-side facts: shipment creation at the
 *   provider, AWB assignment, label generation, courier pickup/handover
 *   confirmation, tracking milestones, delivery, and cancellation outcomes.
 * - The OMS (TechMart) maintains the canonical projection in its own tables
 *   (Fulfillment / Shipment / Order). It never treats provider-side artifacts as
 *   shipping proof:
 *
 *   **PACKING OR AWB/LABEL GENERATION ALONE MUST NEVER MARK AN ORDER SHIPPED.**
 *
 *   Only a courier handover confirmation (first carrier in-transit scan or the
 *   provider's pickup-confirmed signal) advances a Shipment to IN_TRANSIT and
 *   the Order to SHIPPED. Label/AWB artifacts stop at LABEL_CREATED.
 *
 * CANCELLATION: two DISTINCT states
 * ---------------------------------
 * - `cancellation_requested` — a cancellation request exists (recorded at the
 *   provider or initiated by the OMS). It is a SOFT state: no canonical
 *   Shipment/Order status changes to CANCELLED.
 * - `cancelled` — the provider CONFIRMED the cancellation. Only then does the
 *   canonical projection call `cancelShipment()`.
 * The canonical projection stores the request as `cancellationRequestedAt`
 * bookkeeping and reserves ShipmentStatus.CANCELLED for confirmations only.
 *
 * IDEMPOTENCY / RETRIES / WEBHOOKS / RECONCILIATION
 * -------------------------------------------------
 * - Outbound calls carry a `requestId` idempotency key (deterministic per
 *   logical operation); providers/queues must dedupe on it. Inbound events are
 *   deduped by `(connectionId, externalEventId)` like WMS events.
 * - Inbound events are processed at-least-once via the shared `"webhook-processing"`
 *   queue (single worker, per-event jobId, attempts=5); transition-level guards
 *   make replays no-ops.
 * - `verifyInbound` is mandatory before any parsing; the webhook secret is
 *   per-connection and decrypted at runtime. It is never logged and never
 *   falls back to an environment default.
 * - Reconciliation (Stage 3): periodic polling of open shipments reconciles
 *   missed webhook events by AWB/shipment id; reconciliation runs through the
 *   same `mapShippingEventToCanonicalAction` reducer so projections cannot drift.
 */

export const SHIPPING_CONTRACT_VERSION = "1.0";

export const SHIPPING_PROVIDER_TOKEN = Symbol("SHIPPING_PROVIDER");
export const SHIPPING_ADAPTERS = Symbol("SHIPPING_ADAPTERS");

/** BullMQ queue shared with the existing webhooks worker (dual dispatch). */
export const SHIPPING_EVENT_QUEUE = "webhook-processing";

export enum ShippingProvider {
  FAKE = "FAKE",
  SHIPROCKET = "SHIPROCKET",
}

export enum ShippingCapability {
  SHIPMENT_CREATE = "shipment.create",
  SHIPMENT_CANCEL = "shipment.cancel",
  LABEL_FETCH = "label.fetch",
  TRACKING_QUERY = "tracking.query",
}

/**
 * Provider-side shipment lifecycle (normalized across providers).
 * `cancellation_requested` and `cancelled` are intentionally distinct.
 */
export enum ShippingProviderStatus {
  /** Order/shipment created at the provider; no AWB yet. */
  PENDING = "pending",
  /** AWB assigned and/or label generated. NOT shipped. */
  AWB_ASSIGNED = "awb_assigned",
  /** Pickup requested/scheduled with the courier. NOT shipped. */
  PICKUP_SCHEDULED = "pickup_scheduled",
  /** Courier has the parcel (pickup scan / first carrier scan). SHIPPED point. */
  IN_TRANSIT = "in_transit",
  OUT_FOR_DELIVERY = "out_for_delivery",
  DELIVERED = "delivered",
  DELIVERY_FAILED = "delivery_failed",
  RTO_IN_TRANSIT = "rto_in_transit",
  RTO_DELIVERED = "rto_delivered",
  /** Cancellation REQUEST recorded (soft state; NOT confirmed). */
  CANCELLATION_REQUESTED = "cancellation_requested",
  /** Cancellation CONFIRMED by the provider. */
  CANCELLED = "cancelled",
  LOST = "lost",
  UNKNOWN = "unknown",
}

/** Wire event types for shipping-provider → OMS inbound events. */
export enum ShippingWireEventType {
  /** Provider created (or acknowledged) a shipment; may include AWB/label. */
  SHIPMENT_CREATED = "shipping.shipment.created",
  /** A tracking milestone changed. Never implies shipping by itself. */
  TRACKING_UPDATED = "shipping.tracking.updated",
  /** Explicit delivery confirmation. */
  TRACKING_DELIVERED = "shipping.tracking.delivered",
  /** A cancellation REQUEST exists (soft state). */
  CANCELLATION_REQUESTED = "shipping.cancellation.requested",
  /** The provider CONFIRMED cancellation. */
  CANCELLATION_CONFIRMED = "shipping.cancellation.confirmed",
}

export interface ShippingInboundEvent {
  contractVersion: string;
  type: ShippingWireEventType;
  externalEventId: string;
  externalShipmentId: string;
  /** Provider-side order id when the provider has one (e.g. Shiprocket order id). */
  externalOrderId?: string;
  /** Normalized status carried by the event (from raw provider payloads). */
  status: ShippingProviderStatus;
  awbCode?: string;
  courierName?: string;
  labelUrl?: string;
  trackingNumber?: string;
  occurredAt: string;
  metadata?: Record<string, unknown>;
}

/**
 * Canonical actions the OMS projection may take. The pure reducer
 * `mapShippingEventToCanonicalAction` (in `shipping-status-mapping.ts`) is the
 * ONLY sanctioned way to derive these from wire events; contract tests pin it.
 */
export type ShippingCanonicalAction =
  | { type: "record_shipment_created"; externalShipmentId: string; awbCode?: string; courierName?: string; labelUrl?: string }
  | { type: "record_label_created"; externalShipmentId: string; awbCode?: string; labelUrl?: string }
  | {
      /** ONLY this action may advance a Shipment to IN_TRANSIT / Order to SHIPPED. */
      type: "record_handover_confirmed";
      externalShipmentId: string;
    }
  | { type: "record_delivered"; externalShipmentId: string }
  | {
      /** Soft state: record the request (cancellationRequestedAt). NO status change. */
      type: "record_cancellation_requested";
      externalShipmentId: string;
    }
  | {
      /** Confirmed cancellation: `cancelShipment()` and release the order. */
      type: "record_cancellation_confirmed";
      externalShipmentId: string;
    }
  | {
      /** Informational progress (e.g. pickup scheduled): bookkeeping only. */
      type: "record_progress";
      externalShipmentId: string;
      status: ShippingProviderStatus;
    }
  | { type: "reject_event"; externalShipmentId: string; reason: string };

/**
 * True only for statuses that PROVE courier handover. AWB assignment, label
 * generation, and pickup scheduling must return false (contract-pinned).
 */
export function doesStatusMarkHandover(status: ShippingProviderStatus): boolean {
  return (
    status === ShippingProviderStatus.IN_TRANSIT ||
    status === ShippingProviderStatus.OUT_FOR_DELIVERY ||
    status === ShippingProviderStatus.DELIVERED ||
    status === ShippingProviderStatus.RTO_IN_TRANSIT ||
    status === ShippingProviderStatus.RTO_DELIVERED
  );
}

// ---------------------------------------------------------------------------
// Outbound port (OMS -> shipping provider). Implemented by real adapters in
// Stage 3 (Shiprocket) and by fakes for deterministic tests now.
// ---------------------------------------------------------------------------

export interface CreateShippingShipmentRequest {
  /** Idempotency key, e.g. `ship-${shipmentId}`. Stable across retries. */
  requestId: string;
  fulfillmentId: string;
  shipmentId: string;
  order: {
    externalOrderNumber?: string;
    orderDate: string;
    paymentMethod: "PREPAID" | "COD";
  };
  deliveryAddress: {
    name: string;
    address: string;
    address2?: string;
    city: string;
    state: string;
    pincode: string;
    country: string;
    email?: string;
    phone?: string;
  };
  items: Array<{
    sku: string;
    name: string;
    units: number;
    sellingPrice: string;
  }>;
  dimensions: {
    length: number;
    breadth: number;
    height: number;
    weight: number;
  };
  metadata?: Record<string, unknown>;
}

export interface CreateShippingShipmentResult {
  externalShipmentId: string;
  externalOrderId?: string;
  awbCode?: string;
  courierName?: string;
  labelUrl?: string;
  raw?: unknown;
}

export interface RequestShippingCancellationRequest {
  /** Idempotency key, e.g. `cancel-${shipmentId}`. */
  requestId: string;
  externalShipmentId: string;
  awbCode?: string;
  reason?: string;
}

export interface RequestShippingCancellationResult {
  /** Never `cancelled` unless the provider CONFIRMED synchronously. */
  status: ShippingProviderStatus.CANCELLATION_REQUESTED | ShippingProviderStatus.CANCELLED;
  raw?: unknown;
}

export interface FetchShippingLabelRequest {
  externalShipmentId: string;
  awbCode?: string;
}

export interface FetchShippingLabelResult {
  labelUrl: string;
  raw?: unknown;
}

export interface FetchShippingTrackingRequest {
  externalShipmentId?: string;
  awbCode?: string;
}

export interface ShippingTrackingPoint {
  status: ShippingProviderStatus;
  occurredAt: string;
  location?: string;
  description?: string;
  raw?: unknown;
}

export interface FetchShippingTrackingResult {
  currentStatus: ShippingProviderStatus;
  history: ShippingTrackingPoint[];
  raw?: unknown;
}

export interface ShippingInboundEnvelope {
  externalEventId: string;
  event: ShippingInboundEvent;
}

export interface ShippingConnectionSecrets {
  /** Provider API credential material (e.g. Shiprocket API user email). */
  apiEmail?: string;
  /** Provider API password/token. Decrypted at runtime; never logged. */
  apiPassword?: string;
  /** Webhook verification secret shared with the provider. */
  webhookSecret?: string;
}

export interface ShippingProviderAdapter {
  readonly provider: ShippingProvider;
  readonly contractVersion: string;
  readonly capabilities: readonly ShippingCapability[];

  createShipment(request: CreateShippingShipmentRequest): Promise<CreateShippingShipmentResult>;
  requestCancellation(request: RequestShippingCancellationRequest): Promise<RequestShippingCancellationResult>;
  fetchLabel?(request: FetchShippingLabelRequest): Promise<FetchShippingLabelResult>;
  fetchTracking?(request: FetchShippingTrackingRequest): Promise<FetchShippingTrackingResult>;

  /** Parse a raw webhook body into the wire envelope (validates contract version). */
  readInboundEnvelope(raw: unknown): ShippingInboundEnvelope;
  /** Mandatory authenticity check before any parsing/persistence. */
  verifyInbound(rawBody: Buffer | string, headers: Record<string, string | string[] | undefined>, secrets: ShippingConnectionSecrets): boolean;
}

export function isShippingAdapter(value: unknown): value is ShippingProviderAdapter {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<ShippingProviderAdapter>;
  return (
    typeof candidate.provider === "string" &&
    typeof candidate.contractVersion === "string" &&
    Array.isArray(candidate.capabilities) &&
    typeof candidate.createShipment === "function" &&
    typeof candidate.requestCancellation === "function" &&
    typeof candidate.readInboundEnvelope === "function" &&
    typeof candidate.verifyInbound === "function"
  );
}

export const SHIPPING_STATUS_DESCRIPTIONS: Record<ShippingProviderStatus, string> = {
  [ShippingProviderStatus.PENDING]: "Shipment created at the provider; no AWB assigned yet.",
  [ShippingProviderStatus.AWB_ASSIGNED]: "AWB assigned and/or label generated. NOT shipped.",
  [ShippingProviderStatus.PICKUP_SCHEDULED]: "Pickup requested/scheduled with the courier. NOT shipped.",
  [ShippingProviderStatus.IN_TRANSIT]: "Courier has the parcel (handover confirmed). Shipment is IN_TRANSIT; order is SHIPPED.",
  [ShippingProviderStatus.OUT_FOR_DELIVERY]: "Parcel is out for final delivery.",
  [ShippingProviderStatus.DELIVERED]: "Delivery confirmed by the carrier.",
  [ShippingProviderStatus.DELIVERY_FAILED]: "Delivery attempt failed; awaiting retry or RTO.",
  [ShippingProviderStatus.RTO_IN_TRANSIT]: "Return-to-origin in transit.",
  [ShippingProviderStatus.RTO_DELIVERED]: "Return-to-origin completed.",
  [ShippingProviderStatus.CANCELLATION_REQUESTED]: "Cancellation REQUEST exists (soft state). NOT confirmed.",
  [ShippingProviderStatus.CANCELLED]: "Cancellation CONFIRMED by the provider.",
  [ShippingProviderStatus.LOST]: "Shipment reported lost by the carrier.",
  [ShippingProviderStatus.UNKNOWN]: "Unrecognized provider status; raw value preserved in metadata.",
};

/**
 * TechMart ↔ WMS integration contract — Stage 1, contract version 1.0.
 *
 * Provider-neutral boundary between TechMart OMS and merchant warehouse
 * management systems. Two strictly separated directions:
 *
 * - **Outbound commands** (TechMart → WMS): `WmsSubmitFulfillmentRequest*`
 *   — what TechMart asks a warehouse to do.
 * - **Inbound events** (WMS → TechMart): `WmsInboundEvent*` — what the
 *   warehouse reports back. Durable, idempotent, authenticated per
 *   connection (see WmsEventIntakeService).
 *
 * Versioning rules (v1.0):
 *
 * - `WMS_CONTRACT_VERSION` changes when a payload shape or operation set
 *   changes incompatibly. Adapters pin the version they were built for and
 *   `submitFulfillmentRequest` is rejected on mismatch — a wrong-version
 *   command must never reach a warehouse half-understood.
 * - Adding NEW optional fields or new inbound event types is a minor
 *   (compatible) change: v1.x adapters may ignore event types they do not
 *   know (TechMart records and rejects unknown types explicitly).
 * - The interface only declares operations that Stage 1 actually
 *   implements. Unimplemented provider capabilities are NOT invented: a
 *   real WMS adapter arrives in a later stage and declares only what it
 *   truly supports via `capabilities`.
 *
 * Stage 1 registers exactly one adapter: the deterministic FAKE
 * (src/wms/fake/fake-wms.adapter.ts). No real WMS product or shipping
 * provider (Shiprocket et al.) is integrated or implied. Shipping-provider
 * operations — labels, AWBs, tracking — are deliberately NOT part of this
 * contract: a label never implies an item was picked, packed, or handed
 * to a carrier (see wms-status-mapping.ts).
 */

import { WmsProvider } from "@prisma/client";

export const WMS_CONTRACT_VERSION = "1.0";

/**
 * Canonical inbound wire event types (provider adapters translate their
 * own vocabulary into these). The full event → canonical-state mapping
 * lives in wms-status-mapping.ts; anything outside this set is recorded
 * and rejected, never applied.
 */
export const WMS_EVENT_TYPES = {
  /** The warehouse accepted the request and will execute it. */
  ACKNOWLEDGED: "fulfillment.acknowledged",
  /** Pick progress; `lines[].quantity` are CUMULATIVE picked totals. */
  PICKED: "fulfillment.picked",
  /** Pack progress; `lines[].quantity` are CUMULATIVE packed totals. */
  PACKED: "fulfillment.packed",
  /**
   * Carrier handover: `lines[].quantity` are the quantities in THIS
   * handover (one shipment per event).
   */
  SHIPPED: "fulfillment.shipped",
  /** The warehouse cannot execute the request (or the remainder). */
  FAILED: "fulfillment.failed",
  /** The request was cancelled before/without full execution. */
  CANCELLED: "fulfillment.cancelled",
} as const;

export type WmsEventType =
  (typeof WMS_EVENT_TYPES)[keyof typeof WMS_EVENT_TYPES];

/** Capabilities an adapter may honestly claim. Stage 1 has exactly one. */
export type WmsCapability = "fulfillment.submit";

// ============================================================
// Outbound: TechMart → WMS
// ============================================================

export type WmsSubmitFulfillmentRequestCommand = {
  contractVersion: string;

  /**
   * Stable across every retry of the same fulfillment. A conforming
   * adapter (and the warehouse behind it) MUST treat a repeated
   * idempotency key as the same request — never as a second one.
   */
  idempotencyKey: string;

  externalWarehouseId: string;

  request: {
    /** Same value as `idempotencyKey`; echoed by inbound events to correlate. */
    requestRef: string;
    /** Human-readable order reference (order number). */
    orderReference: string;
    /** ISO-8601 timestamp of when TechMart created the request. */
    requestedAt: string;

    lines: Array<{
      /** Stable per-line reference echoed by inbound events. */
      externalLineRef: string;
      sku: string;
      quantity: number;
    }>;
  };
};

export type WmsSubmitFulfillmentRequestResult = {
  /** The warehouse's identity for this request. */
  externalRequestId: string;
};

// ============================================================
// Inbound: WMS → TechMart
// ============================================================

export type WmsInboundEventPayload = {
  /** Canonical wire value from WMS_EVENT_TYPES; unknown → recorded rejection. */
  eventType: string;

  /** The provider's id for this event (also in the envelope headers). */
  externalEventId: string;

  /** Correlates to the outbound request (`idempotencyKey` we submitted). */
  requestRef: string;

  /** The warehouse's request id, when known. */
  externalRequestId?: string;

  /** ISO-8601 timestamp of when the event occurred at the warehouse. */
  occurredAt: string;

  /**
   * Quantities per request line. Cumulative stage totals for
   * picked/packed; per-handover quantities for shipped.
   */
  lines?: Array<{
    externalLineRef: string;
    quantity: number;
  }>;

  /** Present on `fulfillment.shipped` — shipment facts, not warehouse stages. */
  shipment?: {
    externalShipmentId: string;
    carrier?: string;
    service?: string;
    trackingNumber?: string;
    trackingUrl?: string;
  };

  /** Present on `fulfillment.failed`. */
  failureReason?: string;
};

/** Identity of one delivery, extracted from provider headers. */
export type WmsInboundEnvelope = {
  externalWarehouseId: string;
  externalEventId: string;
};

export type ReadWmsInboundHeaders = Record<
  string,
  string | string[] | undefined
>;

export type VerifyWmsInboundInput = {
  /** Raw request body — signatures are computed over these exact bytes. */
  rawBody: Buffer;
  headers: ReadWmsInboundHeaders;
  envelope: WmsInboundEnvelope;
  connection: { id: string; encryptedWebhookSecret: string | null };
};

// ============================================================
// The adapter boundary
// ============================================================

export interface WmsAdapter {
  readonly provider: WmsProvider;
  /** The contract version this adapter speaks. */
  readonly contractVersion: string;
  /** What this adapter honestly supports. Nothing more may be assumed. */
  readonly capabilities: readonly WmsCapability[];

  /**
   * Submit a fulfillment request. MUST be idempotent on `idempotencyKey`:
   * calling twice with the same key yields the same request at the
   * warehouse, never a duplicate.
   */
  submitFulfillmentRequest(
    command: WmsSubmitFulfillmentRequestCommand,
  ): Promise<WmsSubmitFulfillmentRequestResult>;

  /** Extract delivery identity from provider headers. */
  readInboundEnvelope(headers: ReadWmsInboundHeaders): WmsInboundEnvelope;

  /**
   * Authenticate one raw delivery against the secret belonging to this
   * connection. Throws when the signature does not verify. Never
   * persists anything; never logs secrets.
   */
  verifyInbound(input: VerifyWmsInboundInput): Promise<void>;
}

/** DI token for the registered WMS adapters, one per provider. */
export const WMS_ADAPTERS = Symbol("WMS_ADAPTERS");

/**
 * Outbound port for durable WMS event queueing. Implemented on the
 * EXISTING BullMQ infrastructure (src/queue/wms-event.queue.ts) — Stage 1
 * introduces no new queue technology.
 */
export interface WmsEventQueue {
  enqueue(wmsEventId: string): Promise<void>;
  requeue(wmsEventId: string): Promise<void>;
}

export const WMS_EVENT_QUEUE = Symbol("WMS_EVENT_QUEUE");

export function wmsAdapterForProvider(
  adapters: readonly WmsAdapter[],
  provider: WmsProvider,
): WmsAdapter {
  const adapter = adapters.find((candidate) => candidate.provider === provider);

  if (!adapter) {
    throw new Error(`No WMS adapter registered for provider ${provider}`);
  }

  return adapter;
}

import { StorePlatform } from "@prisma/client";

/**
 * The channel-specific inbound boundary (locked decision 1).
 *
 * Everything a sales channel is allowed to impose on this system on the
 * inbound path — HTTP header names, signature schemes, topic vocabulary,
 * payload shapes, raw snapshots — lives behind exactly one interface:
 * `ChannelConnector`. Canonical OMS logic (orders, inventory, exceptions,
 * resolution, audit) sees only the types declared here.
 *
 * Outbound writes already have their own boundary: `ActionAdapter`
 * (src/ai/actuation/action-adapter.interface.ts). Nothing else in this
 * interface is speculative — each method exists because the webhook
 * pipeline calls it today.
 */

/**
 * The only order representation that enters canonical OMS logic
 * (locked decision 2). Channel payload parsing must not exist outside
 * the connector that produces this type (locked decision 3).
 */
export type NormalizedOrderLine = {
  /** The line's own identity on the channel. */
  externalLineItemId: string;
  /**
   * The channel's catalog-item reference for this line (e.g. the
   * channel's variant/inventory-item id), when the payload carries one.
   * Used as the primary key for canonical inventory resolution via
   * InventoryItemExternalReference (locked decision 4).
   */
  externalItemRef: string | null;
  /** The SKU as observed on the channel; may differ from the canonical SKU. */
  sku: string;
  title: string;
  quantity: number;
  /** Decimal amount as a string; null when the channel sent no price. */
  unitPrice: string | null;
};

export type NormalizedOrder = {
  externalOrderId: string;
  orderNumber: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  /** Decimal amount as a string. */
  totalAmount: string;
  currency: string;
  orderedAt: Date;
  /** True when the channel reports the order cancelled (any cancel source). */
  cancelled: boolean;
  /**
   * Line items carried by this event. `undefined` means the event had
   * no line-item information (partial update) and lines must be left
   * alone; `[]` means the channel explicitly sent no lines.
   */
  lines?: NormalizedOrderLine[];
};

/** Identity of one webhook delivery, extracted from channel HTTP headers. */
export type DeliveryEnvelope = {
  /** The channel's id for this delivery; the idempotency key (locked decision 6). */
  externalEventId: string;
  topic: string;
  /**
   * The channel's name for the store that sent the delivery. Resolved to
   * `StoreConnection.externalStoreId` (locked decision 5) under the
   * connector's platform.
   */
  storeKey: string;
};

/**
 * What a channel topic means to the processor. The processor switches on
 * these intents and never sees topic strings (locked decision 1).
 */
export type DeliveryIntent =
  | { kind: "ORDER_UPSERT" }
  | { kind: "STORE_DISCONNECTED" }
  | { kind: "PRIVACY_REQUEST" }
  | { kind: "IGNORED"; reason: string };

export type ReadEnvelopeHeaders = Record<
  string,
  string | string[] | undefined
>;

export type VerifyDeliveryInput = {
  rawBody: Buffer;
  headers: ReadEnvelopeHeaders;
  store: { id: string; encryptedWebhookSecret: string | null };
  /** Already-extracted identity, for exact diagnostic messages. */
  envelope: DeliveryEnvelope;
};

export type RecordRawSnapshotInput = {
  tenantId: string;
  storeId: string;
  payload: unknown;
};

export interface ChannelConnector {
  readonly platform: StorePlatform;

  /**
   * Channel HTTP headers → delivery identity. Pure header parsing and
   * validation; no authentication (that needs the store's secret).
   * Throws BadRequestException when required headers are missing.
   */
  readEnvelope(headers: ReadEnvelopeHeaders): DeliveryEnvelope;

  /**
   * Authenticate one raw delivery against the secret belonging to this
   * app on the store that sent it. Throws UnauthorizedException when the
   * signature does not verify. Never persists anything.
   */
  verifyDelivery(input: VerifyDeliveryInput): Promise<void>;

  /** Channel topic vocabulary → processor intent. */
  mapTopic(topic: string): DeliveryIntent;

  /**
   * Channel payload → canonical order command. Throws on malformed
   * payloads; the error messages are part of this connector's observable
   * behaviour and its parity contract.
   */
  normalizeOrder(input: { topic: string; payload: unknown }): NormalizedOrder;

  /**
   * Optional channel-private raw snapshot, written before canonical
   * processing. Connectors without a raw archive omit this.
   */
  recordRawSnapshot?(input: RecordRawSnapshotInput): Promise<void>;
}

/** DI token for the installed connectors, one per supported platform. */
export const CHANNEL_CONNECTORS = Symbol("CHANNEL_CONNECTORS");

export function connectorForPlatform(
  connectors: readonly ChannelConnector[],
  platform: StorePlatform,
): ChannelConnector {
  const connector = connectors.find((entry) => entry.platform === platform);

  if (!connector) {
    throw new Error(`No channel connector registered for platform ${platform}`);
  }

  return connector;
}

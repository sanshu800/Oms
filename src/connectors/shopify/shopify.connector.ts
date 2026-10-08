import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { StorePlatform } from "@prisma/client";

import { decryptSecret } from "../../shopify/shopify-auth.crypto";
import { isComplianceRestTopic } from "../../shopify/webhook-registration";
import { verifyShopifyWebhook } from "../../webhooks/shopify-signature";

import {
  ChannelConnector,
  DeliveryEnvelope,
  DeliveryIntent,
  NormalizedOrder,
  NormalizedOrderLine,
  ReadEnvelopeHeaders,
  RecordRawSnapshotInput,
  VerifyDeliveryInput,
} from "../connector.interface";
import {
  RAW_ORDER_SNAPSHOT_STORE,
  RawOrderSnapshotStore,
} from "../raw-order-snapshot.port";

/**
 * The Shopify implementation of the ChannelConnector boundary.
 *
 * Every channel-specific inbound behaviour of the Shopify integration
 * lives in this file and nowhere else: header names, HMAC verification,
 * topic vocabulary, webhook payload parsing, and the raw order snapshot.
 * The parsing helpers were moved verbatim from OrderService and
 * WebhookProcessorService — their error messages are an observable
 * parity contract (see shopify-ingest-parity.spec.ts and
 * shopify-snapshot-parity.spec.ts) and intentionally unchanged.
 */
@Injectable()
export class ShopifyConnector implements ChannelConnector {
  readonly platform = StorePlatform.SHOPIFY;

  private readonly logger = new Logger(ShopifyConnector.name);

  constructor(
    @Inject(RAW_ORDER_SNAPSHOT_STORE)
    private readonly snapshots: RawOrderSnapshotStore,
    private readonly config: ConfigService,
  ) {}

  readEnvelope(headers: ReadEnvelopeHeaders): DeliveryEnvelope {
    const shopDomain = getHeader(headers, "x-shopify-shop-domain");
    const webhookId = getHeader(headers, "x-shopify-webhook-id");
    const topic = getHeader(headers, "x-shopify-topic");

    if (!shopDomain || !webhookId || !topic) {
      throw new BadRequestException(
        "Required Shopify webhook headers are missing",
      );
    }

    return {
      storeKey: String(shopDomain),
      externalEventId: String(webhookId),
      topic: String(topic),
    };
  }

  /**
   * Authenticates one delivery against the secret that belongs to the app
   * installed on this store (moved from WebhookIntakeService.verifySignature).
   *
   * Order matters and is intentional: a store-specific secret wins over the
   * deployment-wide one, and a store-specific secret that does not match is
   * *not* retried against the environment secret. Falling back after a
   * mismatch would turn "someone rotated the secret in Shopify" into a
   * confusing half-working state instead of a clear 401 in the logs plus the
   * sentence below.
   */
  async verifyDelivery(input: VerifyDeliveryInput): Promise<void> {
    const signature = getHeader(input.headers, "x-shopify-hmac-sha256");

    let secret: string;
    let source: "store" | "environment";

    if (input.store.encryptedWebhookSecret) {
      const encryptionKey = this.config.get<string>("ENCRYPTION_KEY");

      if (!encryptionKey) {
        throw new Error(
          "ENCRYPTION_KEY is not configured, so the store's webhook secret cannot be decrypted",
        );
      }

      try {
        secret = decryptSecret(input.store.encryptedWebhookSecret, encryptionKey);
      } catch {
        throw new Error(
          `The stored webhook secret for store ${input.store.id} cannot be decrypted with the current ENCRYPTION_KEY. Reconnect the store (connect-shopify-store.ts) with the right key.`,
        );
      }

      source = "store";
    } else {
      const environmentSecret =
        this.config.get<string>("SHOPIFY_WEBHOOK_SECRET");

      if (!environmentSecret) {
        throw new Error(
          `SHOPIFY_WEBHOOK_SECRET is not configured and store ${input.store.id} has no stored webhook secret, so deliveries from ${input.envelope.storeKey} cannot be verified`,
        );
      }

      secret = environmentSecret;
      source = "environment";
    }

    if (!verifyShopifyWebhook(input.rawBody, signature, secret)) {
      this.logger.warn(
        `Rejected ${input.envelope.topic} from ${input.envelope.storeKey}: HMAC did not match the ${
          source === "store"
            ? "store-specific secret"
            : "deployment-wide SHOPIFY_WEBHOOK_SECRET"
        }. If the secret was rotated in Shopify, reconnect or update the store connection.`,
      );

      throw new UnauthorizedException("Invalid Shopify webhook signature");
    }
  }

  mapTopic(topic: string): DeliveryIntent {
    if (
      topic === "orders/create" ||
      topic === "orders/updated" ||
      topic === "orders/cancelled"
    ) {
      return { kind: "ORDER_UPSERT" };
    }

    if (topic === "app/uninstalled") {
      return { kind: "STORE_DISCONNECTED" };
    }

    if (isComplianceRestTopic(topic)) {
      return { kind: "PRIVACY_REQUEST" };
    }

    return { kind: "IGNORED", reason: "Unsupported webhook topic" };
  }

  normalizeOrder(input: {
    topic: string;
    payload: unknown;
  }): NormalizedOrder {
    const payload = requireShopifyObject(input.payload);
    const topic = input.topic;
    const isCancelled =
      topic === "orders/cancelled" || Boolean(payload.cancelled_at);

    return {
      externalOrderId: requireShopifyString(payload.id, "order.id"),
      orderNumber: requireShopifyString(payload.name, "order.name"),
      paymentStatus: requireShopifyString(
        payload.financial_status,
        "order.financial_status",
      ),
      fulfillmentStatus:
        typeof payload.fulfillment_status === "string"
          ? payload.fulfillment_status
          : "unfulfilled",
      totalAmount: requireShopifyString(
        payload.total_price,
        "order.total_price",
      ),
      currency: requireShopifyString(payload.currency, "order.currency"),
      orderedAt: requireShopifyDate(payload.created_at, "order.created_at"),
      cancelled: isCancelled,
      lines: Array.isArray(payload.line_items)
        ? parseLineItems(payload.line_items)
        : undefined,
    };
  }

  async recordRawSnapshot(input: RecordRawSnapshotInput): Promise<void> {
    const payload = requireShopifyObject(input.payload);

    const externalOrderId = requireShopifyId(payload.id, "order.id");

    const orderName =
      typeof payload.name === "string" ? payload.name : externalOrderId;

    const financialStatus =
      typeof payload.financial_status === "string"
        ? payload.financial_status
        : "unknown";

    const fulfillmentStatus =
      typeof payload.fulfillment_status === "string"
        ? payload.fulfillment_status
        : "unfulfilled";

    const externalCreatedAt = requireDate(
      payload.created_at,
      "order.created_at",
    );

    const externalUpdatedAt = requireDate(
      payload.updated_at,
      "order.updated_at",
    );

    // Persistence is infrastructure: the connector produces the record and
    // hands it to the neutral snapshot port (see raw-order-snapshot.port.ts).
    await this.snapshots.upsert({
      tenantId: input.tenantId,
      storeId: input.storeId,
      externalOrderId,
      orderName,
      financialStatus,
      fulfillmentStatus,
      rawPayload: payload,
      externalCreatedAt,
      externalUpdatedAt,
    });
  }
}

function getHeader(
  headers: ReadEnvelopeHeaders,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return Array.isArray(value) ? value[0] : value;
    }
  }

  return undefined;
}

function requireShopifyObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Shopify order payload must be an object");
  }

  return value as Record<string, unknown>;
}

function parseLineItems(value: unknown[]): NormalizedOrderLine[] {
  const externalLineItemIds = new Set<string>();

  return value.map((rawItem, index) => {
    const item = rawItem as Record<string, unknown>;

    const externalLineItemId = requireShopifyString(
      item.id,
      `order.line_items[${index}].id`,
    );
    if (externalLineItemIds.has(externalLineItemId)) {
      throw new Error(
        `Duplicate Shopify line item ID: ${externalLineItemId}`,
      );
    }
    externalLineItemIds.add(externalLineItemId);

    const sku =
      typeof item.sku === "string" && item.sku.trim() !== ""
        ? item.sku.trim()
        : requireShopifyString(
            item.variant_id,
            `order.line_items[${index}].variant_id`,
          );

    const title =
      typeof item.title === "string" && item.title.trim() !== ""
        ? item.title.trim()
        : sku;

    const quantity = Number(item.quantity);

    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new Error(
        `Invalid quantity for order.line_items[${index}]`,
      );
    }

    const price =
      typeof item.price === "string" || typeof item.price === "number"
        ? String(item.price)
        : null;

    return {
      externalLineItemId,
      externalItemRef: normalizeExternalItemRef(item.variant_id),
      sku,
      title,
      quantity,
      unitPrice: price,
    };
  });
}

/**
 * The catalog-item reference used for canonical inventory mapping
 * (InventoryItemExternalReference). Shopify order webhooks carry the
 * variant id; a line without one resolves by SKU fallback only (the
 * explicitly defined rule in src/oms/inventory/canonical-mapping.ts).
 */
function normalizeExternalItemRef(value: unknown): string | null {
  if (typeof value === "number") {
    return String(value);
  }

  if (typeof value === "string" && value.trim() !== "") {
    return String(value);
  }

  return null;
}

function requireShopifyString(value: unknown, field: string): string {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    String(value).trim() === ""
  ) {
    throw new Error(`Missing required Shopify field: ${field}`);
  }

  return String(value);
}

function requireShopifyDate(value: unknown, field: string): Date {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required Shopify field: ${field}`);
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid Shopify date: ${field}`);
  }

  return date;
}

function requireShopifyId(value: unknown, field: string): string {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    String(value).trim() === ""
  ) {
    throw new Error(`Missing required Shopify field: ${field}`);
  }

  return String(value);
}

function requireDate(value: unknown, field: string): Date {
  if (typeof value !== "string" && !(value instanceof Date)) {
    throw new Error(`Missing required Shopify field: ${field}`);
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid Shopify date: ${field}`);
  }

  return date;
}

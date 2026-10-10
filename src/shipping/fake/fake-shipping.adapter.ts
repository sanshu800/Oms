import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ShippingProvider } from "@prisma/client";
import { createHmac, timingSafeEqual } from "crypto";

import { decryptSecret } from "../../shopify/shopify-auth.crypto";

import {
  CreateShippingShipmentRequest,
  CreateShippingShipmentResult,
  FetchShippingLabelRequest,
  FetchShippingLabelResult,
  FetchShippingTrackingRequest,
  FetchShippingTrackingResult,
  ReadShippingInboundHeaders,
  ReadShippingInboundInput,
  RequestShippingCancellationRequest,
  RequestShippingCancellationResult,
  SHIPPING_CONTRACT_VERSION,
  ShippingCapability,
  ShippingInboundEnvelope,
  ShippingInboundEvent,
  ShippingProviderAdapter,
  ShippingProviderError,
  ShippingProviderStatus,
  VerifyShippingInboundInput,
} from "../shipping-contract";

/**
 * Deterministic fake shipping provider (Stage 2).
 *
 * A complete, in-memory carrier: it creates shipments and AWBs
 * idempotently, tracks lifecycle statuses, cancels on request, and the
 * test harness (`buildSignedDelivery`) emits authenticated inbound
 * events exactly as a real shipping provider would. Everything is
 * deterministic — provider ids derive from the idempotency key, there is
 * no clock or randomness in any output — so end-to-end tests run without
 * paid services or external credentials.
 *
 * Timeouts and upstream failures are injectable (`timeoutNextCreate`,
 * `failNextCreate`, ...) so retry/idempotency behavior is testable.
 *
 * It honestly claims `shipment.create`, `shipment.cancel`, `label.fetch`
 * and `tracking.query`. No real shipping provider is modeled or implied.
 *
 * Its wire format (provider-local, like any real adapter):
 * - headers: `x-shipping-account-id`, `x-shipping-event-id`,
 *   `x-shipping-signature` (hex HMAC-SHA256 over the raw body)
 * - body: the canonical wire event (`shipping-contract.ts`)
 * - the signature secret is the connection's `encryptedWebhookSecret`
 *   (deliberately no deployment-wide fallback).
 */
@Injectable()
export class FakeShippingProviderAdapter implements ShippingProviderAdapter {
  readonly provider = ShippingProvider.FAKE;
  readonly contractVersion = SHIPPING_CONTRACT_VERSION;
  readonly capabilities = [
    ShippingCapability.SHIPMENT_CREATE,
    ShippingCapability.SHIPMENT_CANCEL,
    ShippingCapability.LABEL_FETCH,
    ShippingCapability.TRACKING_QUERY,
  ] as const;

  private readonly logger = new Logger(FakeShippingProviderAdapter.name);

  /** The fake carrier's shipment book, keyed by idempotency key. */
  private readonly shipmentsByRequest = new Map<
    string,
    {
      externalShipmentId: string;
      externalOrderId: string;
      awbCode: string;
      labelUrl: string;
      courierName: string;
    }
  >();

  /** Cancellation book: externalShipmentId -> confirmed? */
  private readonly cancellations = new Map<string, boolean>();

  /** Test-driven tracking status per externalShipmentId. */
  private readonly trackingStatus = new Map<string, ShippingProviderStatus>();

  /** One-shot failure injections for retry tests (consumed on use). */
  private injectedCreateFailure: { code: "TIMEOUT" | "UPSTREAM_ERROR"; message: string } | null = null;
  private injectedCancelFailure: { code: "TIMEOUT" | "UPSTREAM_ERROR"; message: string } | null = null;

  constructor(private readonly config: ConfigService) {}

  /** Test hook: make the next createShipment throw exactly once. */
  failNextCreate(message: string, code: "TIMEOUT" | "UPSTREAM_ERROR" = "UPSTREAM_ERROR"): void {
    this.injectedCreateFailure = { code, message };
  }

  /** Test hook: make the next createShipment time out exactly once. */
  timeoutNextCreate(): void {
    this.failNextCreate(
      "Fake shipping provider timed out creating the shipment",
      "TIMEOUT",
    );
  }

  /** Test hook: make the next requestCancellation throw exactly once. */
  failNextCancel(message: string, code: "TIMEOUT" | "UPSTREAM_ERROR" = "UPSTREAM_ERROR"): void {
    this.injectedCancelFailure = { code, message };
  }

  timeoutNextCancel(): void {
    this.failNextCancel(
      "Fake shipping provider timed out requesting cancellation",
      "TIMEOUT",
    );
  }

  /** Test hook: the next requestCancellation CONFIRMS synchronously. */
  confirmNextCancellation(): void {
    this.confirmCancellationOnce = true;
  }

  private confirmCancellationOnce = false;

  /** Test hook: drive the tracking status returned by fetchTracking. */
  setTrackingStatus(externalShipmentId: string, status: ShippingProviderStatus): void {
    this.trackingStatus.set(externalShipmentId, status);
  }

  /** Test hook: how many DISTINCT carrier shipments exist. */
  get carrierShipmentCount(): number {
    return this.shipmentsByRequest.size;
  }

  async createShipment(
    request: CreateShippingShipmentRequest,
  ): Promise<CreateShippingShipmentResult> {
    if (!request.requestId) {
      throw new ShippingProviderError(
        "INVALID_REQUEST",
        "Shipping shipment request requires an idempotency key",
      );
    }

    if (request.items.length === 0) {
      throw new ShippingProviderError(
        "INVALID_REQUEST",
        "Shipping shipment request must contain at least one item",
      );
    }

    for (const item of request.items) {
      if (!item.sku || !item.name) {
        throw new ShippingProviderError(
          "INVALID_REQUEST",
          "Shipping shipment request item is missing its SKU or name",
        );
      }

      if (!Number.isInteger(item.units) || item.units <= 0) {
        throw new ShippingProviderError(
          "INVALID_REQUEST",
          `Shipping shipment request item ${item.sku} has an invalid quantity`,
        );
      }
    }

    if (this.injectedCreateFailure) {
      const failure = this.injectedCreateFailure;
      this.injectedCreateFailure = null;
      this.logger.warn(
        `Fake shipping provider rejecting create of ${request.requestId}: ${failure.message}`,
      );
      throw new ShippingProviderError(failure.code, failure.message);
    }

    // Idempotency: the carrier shipment is keyed by the idempotency key.
    const existing = this.shipmentsByRequest.get(request.requestId);

    if (existing) {
      this.logger.log(
        `Fake shipping provider treating repeat create of ${request.requestId} as existing shipment ${existing.externalShipmentId}`,
      );

      return { ...existing, raw: { requestId: request.requestId, repeated: true } };
    }

    // Deterministic identity: derived from the key, never random.
    const created = {
      externalShipmentId: `fake-ship-${request.requestId}`,
      externalOrderId: `fake-sorder-${request.requestId}`,
      awbCode: `FAKEAWB${request.requestId}`,
      labelUrl: `https://fake-shipping.test/labels/${request.requestId}.pdf`,
      courierName: "FAKE-COURIER",
    };

    this.shipmentsByRequest.set(request.requestId, created);
    this.trackingStatus.set(created.externalShipmentId, ShippingProviderStatus.AWB_ASSIGNED);

    return { ...created, raw: { requestId: request.requestId } };
  }

  async requestCancellation(
    request: RequestShippingCancellationRequest,
  ): Promise<RequestShippingCancellationResult> {
    if (!request.requestId || !request.externalShipmentId) {
      throw new ShippingProviderError(
        "INVALID_REQUEST",
        "Cancellation request requires an idempotency key and an external shipment id",
      );
    }

    if (this.injectedCancelFailure) {
      const failure = this.injectedCancelFailure;
      this.injectedCancelFailure = null;
      throw new ShippingProviderError(failure.code, failure.message);
    }

    if (this.cancellations.get(request.externalShipmentId)) {
      return {
        status: ShippingProviderStatus.CANCELLED,
        raw: { requestId: request.requestId, repeated: true },
      };
    }

    if (this.confirmCancellationOnce) {
      this.confirmCancellationOnce = false;
      this.cancellations.set(request.externalShipmentId, true);
      this.trackingStatus.set(request.externalShipmentId, ShippingProviderStatus.CANCELLED);

      return {
        status: ShippingProviderStatus.CANCELLED,
        raw: { requestId: request.requestId },
      };
    }

    // The default is the soft state — cancellation REQUESTED, not confirmed.
    this.trackingStatus.set(
      request.externalShipmentId,
      ShippingProviderStatus.CANCELLATION_REQUESTED,
    );

    return {
      status: ShippingProviderStatus.CANCELLATION_REQUESTED,
      raw: { requestId: request.requestId },
    };
  }

  async fetchLabel(
    request: FetchShippingLabelRequest,
  ): Promise<FetchShippingLabelResult> {
    for (const shipment of this.shipmentsByRequest.values()) {
      if (
        shipment.externalShipmentId === request.externalShipmentId ||
        (request.awbCode && shipment.awbCode === request.awbCode)
      ) {
        return { labelUrl: shipment.labelUrl };
      }
    }

    throw new ShippingProviderError(
      "INVALID_REQUEST",
      `Fake shipping provider has no shipment ${request.externalShipmentId}`,
    );
  }

  async fetchTracking(
    request: FetchShippingTrackingRequest,
  ): Promise<FetchShippingTrackingResult> {
    const externalShipmentId = request.externalShipmentId ?? "";

    const currentStatus =
      this.trackingStatus.get(externalShipmentId) ?? ShippingProviderStatus.UNKNOWN;

    return {
      currentStatus,
      history: [{ status: currentStatus, occurredAt: "2026-10-09T00:00:00.000Z" }],
    };
  }

  readInboundEnvelope(input: ReadShippingInboundInput): ShippingInboundEnvelope {
    const externalAccountId = getHeader(input.headers, "x-shipping-account-id");
    const externalEventId = getHeader(input.headers, "x-shipping-event-id");

    if (!externalAccountId || !externalEventId) {
      throw new BadRequestException(
        "Required shipping webhook headers are missing",
      );
    }

    let body: unknown;

    try {
      body = JSON.parse(input.rawBody.toString("utf8"));
    } catch {
      throw new BadRequestException("Invalid JSON webhook payload");
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new BadRequestException("Shipping webhook payload must be an object");
    }

    const record = body as Record<string, unknown>;

    const type = typeof record.type === "string" ? record.type.trim() : "";
    const eventExternalShipmentId =
      typeof record.externalShipmentId === "string"
        ? record.externalShipmentId.trim()
        : "";

    if (!type || !eventExternalShipmentId) {
      throw new BadRequestException(
        "Shipping webhook payload is missing type or externalShipmentId",
      );
    }

    const event: ShippingInboundEvent = {
      contractVersion:
        typeof record.contractVersion === "string" ? record.contractVersion : "",
      type: type as ShippingInboundEvent["type"],
      externalEventId:
        typeof record.externalEventId === "string" && record.externalEventId.trim() !== ""
          ? record.externalEventId
          : String(externalEventId),
      externalShipmentId: eventExternalShipmentId,
      externalOrderId:
        typeof record.externalOrderId === "string" ? record.externalOrderId : undefined,
      status:
        typeof record.status === "string" && record.status.trim() !== ""
          ? (record.status as ShippingProviderStatus)
          : ShippingProviderStatus.UNKNOWN,
      awbCode: typeof record.awbCode === "string" ? record.awbCode : undefined,
      courierName:
        typeof record.courierName === "string" ? record.courierName : undefined,
      labelUrl: typeof record.labelUrl === "string" ? record.labelUrl : undefined,
      trackingNumber:
        typeof record.trackingNumber === "string" ? record.trackingNumber : undefined,
      occurredAt:
        typeof record.occurredAt === "string" && record.occurredAt.trim() !== ""
          ? record.occurredAt
          : "2026-10-09T00:00:00.000Z",
      metadata:
        record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
          ? (record.metadata as Record<string, unknown>)
          : undefined,
    };

    return {
      externalAccountId: String(externalAccountId),
      externalEventId: String(externalEventId),
      event,
    };
  }

  verifyInbound(input: VerifyShippingInboundInput): boolean {
    const signature = getHeader(input.headers, "x-shipping-signature");

    if (!input.connection.encryptedWebhookSecret) {
      throw new UnauthorizedException(
        `Shipping connection ${input.connection.id} has no webhook secret; deliveries cannot be verified`,
      );
    }

    const encryptionKey = this.config.get<string>("ENCRYPTION_KEY");

    if (!encryptionKey) {
      throw new Error(
        "ENCRYPTION_KEY is not configured, so the shipping webhook secret cannot be decrypted",
      );
    }

    let secret: string;

    try {
      secret = decryptSecret(
        input.connection.encryptedWebhookSecret,
        encryptionKey,
      );
    } catch {
      throw new Error(
        `The stored shipping webhook secret for connection ${input.connection.id} cannot be decrypted with the current ENCRYPTION_KEY.`,
      );
    }

    if (!signature || !verifySignature(input.rawBody, signature, secret)) {
      this.logger.warn(
        `Rejected shipping event ${input.envelope.externalEventId} from account ${input.envelope.externalAccountId}: HMAC did not match the connection secret`,
      );

      return false;
    }

    return true;
  }

  /**
   * Test harness: build one authenticated delivery exactly as the fake
   * carrier would send it (deterministic signature over the raw bytes).
   */
  static buildSignedDelivery(input: {
    secret: string;
    externalAccountId: string;
    event: Record<string, unknown>;
  }): {
    headers: Record<string, string>;
    rawBody: Buffer;
    payload: Record<string, unknown>;
  } {
    const rawBody = Buffer.from(JSON.stringify(input.event), "utf8");

    return {
      headers: {
        "x-shipping-provider": "FAKE",
        "x-shipping-account-id": input.externalAccountId,
        "x-shipping-event-id": String(input.event.externalEventId ?? ""),
        "x-shipping-signature": signPayload(rawBody, input.secret),
      },
      rawBody,
      payload: input.event,
    };
  }
}

function signPayload(rawBody: Buffer, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

function verifySignature(
  rawBody: Buffer,
  signature: string,
  secret: string,
): boolean {
  const expected = signPayload(rawBody, secret);
  const provided = Buffer.from(signature, "utf8");
  const wanted = Buffer.from(expected, "utf8");

  return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}

function getHeader(
  headers: ReadShippingInboundHeaders,
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

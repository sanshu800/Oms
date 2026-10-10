import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { WmsProvider } from "@prisma/client";
import { createHmac, timingSafeEqual } from "crypto";

import { decryptSecret } from "../../shopify/shopify-auth.crypto";

import {
  ReadWmsInboundHeaders,
  VerifyWmsInboundInput,
  WMS_CONTRACT_VERSION,
  WmsAdapter,
  WmsInboundEnvelope,
  WmsSubmitFulfillmentRequestCommand,
  WmsSubmitFulfillmentRequestResult,
} from "../wms-contract";

/**
 * Deterministic fake WMS adapter (Stage 1).
 *
 * A complete, in-memory warehouse: it accepts fulfillment requests
 * idempotently, and the test harness (`buildSignedDelivery`) emits
 * authenticated inbound events exactly as a real WMS would. Everything is
 * deterministic — request ids derive from the idempotency key, there is no
 * clock or randomness in any output — so end-to-end tests run without paid
 * services or external credentials.
 *
 * It honestly claims only `fulfillment.submit`. Nothing about real WMS
 * products is modeled or implied.
 *
 * Its wire format (provider-local, like any real adapter):
 * - headers: `x-wms-warehouse-id`, `x-wms-event-id`,
 *   `x-wms-signature` (hex HMAC-SHA256 over the raw body)
 * - the signature secret is the connection's `encryptedWebhookSecret`
 *   (there is deliberately no deployment-wide fallback: warehouse secrets
 *   are per-merchant and a global default would be a footgun).
 */
@Injectable()
export class FakeWmsAdapter implements WmsAdapter {
  readonly provider = WmsProvider.FAKE;
  readonly contractVersion = WMS_CONTRACT_VERSION;
  readonly capabilities = ["fulfillment.submit"] as const;

  private readonly logger = new Logger(FakeWmsAdapter.name);

  /**
   * The fake warehouse's request book. Keyed by idempotency key — a
   * resubmit of the same key finds the same warehouse request.
   */
  private readonly requests = new Map<
    string,
    { externalRequestId: string; lineCount: number; totalQuantity: number }
  >();

  /** One-shot failure injection for retry tests (consumed on use). */
  private injectedFailure: string | null = null;

  constructor(private readonly config: ConfigService) {}

  /** Test hook: make the next submit throw `message` exactly once. */
  failNextSubmit(message: string): void {
    this.injectedFailure = message;
  }

  /** Test hook: how many DISTINCT warehouse requests exist. */
  get warehouseRequestCount(): number {
    return this.requests.size;
  }

  async submitFulfillmentRequest(
    command: WmsSubmitFulfillmentRequestCommand,
  ): Promise<WmsSubmitFulfillmentRequestResult> {
    if (command.contractVersion !== this.contractVersion) {
      throw new Error(
        `WMS contract version mismatch: adapter speaks ${this.contractVersion}, got ${command.contractVersion}`,
      );
    }

    if (!command.idempotencyKey || !command.request.requestRef) {
      throw new Error("WMS fulfillment request requires an idempotency key");
    }

    if (command.request.lines.length === 0) {
      throw new Error("WMS fulfillment request must contain at least one line");
    }

    for (const line of command.request.lines) {
      if (!line.externalLineRef || !line.sku) {
        throw new Error("WMS fulfillment request line is missing its reference or SKU");
      }

      if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
        throw new Error(
          `WMS fulfillment request line ${line.externalLineRef} has an invalid quantity`,
        );
      }
    }

    if (this.injectedFailure) {
      const message = this.injectedFailure;
      this.injectedFailure = null;
      this.logger.warn(`Fake WMS rejecting submit of ${command.idempotencyKey}: ${message}`);
      throw new Error(message);
    }

    // Idempotency: the warehouse request is keyed by the idempotency key.
    const existing = this.requests.get(command.idempotencyKey);

    if (existing) {
      this.logger.log(
        `Fake WMS treating resubmit of ${command.idempotencyKey} as existing request ${existing.externalRequestId}`,
      );

      return { externalRequestId: existing.externalRequestId };
    }

    // Deterministic identity: derived from the key, never random.
    const externalRequestId = `fake-wms-${command.idempotencyKey}`;

    this.requests.set(command.idempotencyKey, {
      externalRequestId,
      lineCount: command.request.lines.length,
      totalQuantity: command.request.lines.reduce(
        (sum, line) => sum + line.quantity,
        0,
      ),
    });

    return { externalRequestId };
  }

  readInboundEnvelope(headers: ReadWmsInboundHeaders): WmsInboundEnvelope {
    const externalWarehouseId = getHeader(headers, "x-wms-warehouse-id");
    const externalEventId = getHeader(headers, "x-wms-event-id");

    if (!externalWarehouseId || !externalEventId) {
      throw new BadRequestException("Required WMS webhook headers are missing");
    }

    return {
      externalWarehouseId: String(externalWarehouseId),
      externalEventId: String(externalEventId),
    };
  }

  async verifyInbound(input: VerifyWmsInboundInput): Promise<void> {
    const signature = getHeader(input.headers, "x-wms-signature");

    if (!input.connection.encryptedWebhookSecret) {
      throw new UnauthorizedException(
        `WMS connection ${input.connection.id} has no webhook secret; deliveries cannot be verified`,
      );
    }

    const encryptionKey = this.config.get<string>("ENCRYPTION_KEY");

    if (!encryptionKey) {
      throw new Error(
        "ENCRYPTION_KEY is not configured, so the WMS webhook secret cannot be decrypted",
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
        `The stored WMS webhook secret for connection ${input.connection.id} cannot be decrypted with the current ENCRYPTION_KEY.`,
      );
    }

    if (!signature || !verifySignature(input.rawBody, signature, secret)) {
      this.logger.warn(
        `Rejected WMS event ${input.envelope.externalEventId} from warehouse ${input.envelope.externalWarehouseId}: HMAC did not match the connection secret`,
      );

      throw new UnauthorizedException("Invalid WMS webhook signature");
    }
  }

  /**
   * Test harness: build one authenticated delivery exactly as the fake
   * warehouse would send it (deterministic signature over the raw bytes).
   */
  static buildSignedDelivery(input: {
    secret: string;
    externalWarehouseId: string;
    event: Record<string, unknown>;
  }): {
    headers: Record<string, string>;
    rawBody: Buffer;
    payload: Record<string, unknown>;
  } {
    const rawBody = Buffer.from(JSON.stringify(input.event), "utf8");

    return {
      headers: {
        "x-wms-provider": "FAKE",
        "x-wms-warehouse-id": input.externalWarehouseId,
        "x-wms-event-id": String(input.event.externalEventId ?? ""),
        "x-wms-signature": signPayload(rawBody, input.secret),
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
  headers: ReadWmsInboundHeaders,
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

import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { Prisma, WebhookStatus } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";

import {
  ReadWmsInboundHeaders,
  WMS_EVENT_QUEUE,
  WmsAdapter,
  WmsEventQueue,
  WmsInboundEnvelope,
} from "./wms-contract";

export type RecordWmsDeliveryInput = {
  /** The WMS adapter that owns this delivery's auth and vocabulary. */
  adapter: WmsAdapter;
  /** Delivery identity, already extracted by the adapter. */
  envelope: WmsInboundEnvelope;
  headers: ReadWmsInboundHeaders;
  payload: Prisma.InputJsonValue;
  payloadSha256: string;
  rawBody: Buffer;
};

export type RecordedWmsDelivery = {
  wmsEventId: string;
  /** false when the event is already PROCESSING/PROCESSED or enqueued. */
  shouldEnqueue: boolean;
  /** true when a previously failed event is being reset for a retry. */
  resetForRetry: boolean;
};

/**
 * Durable intake for WMS inbound events — the same production contract as
 * WebhookIntakeService, on the warehouse boundary:
 *
 * 1. **Authenticate before storing.** The connection is resolved from the
 *    delivery's warehouse identity, then the adapter verifies the
 *    signature against that connection's secret. A delivery that fails is
 *    rejected WITHOUT being stored — an unauthenticated payload must not
 *    become replayable work.
 * 2. **Store before acknowledging.** Once verified, the event row is
 *    written before queueing, so a delivery is never lost because the
 *    queue is unhealthy. The (connectionId, externalEventId) unique key
 *    makes duplicates ack-without-requeue.
 * 3. **Bounded enqueue.** Queueing runs under the shared enqueue timeout;
 *    if the queue is unreachable the event stays durably stored and the
 *    caller answers 503 so the WMS retries.
 */
@Injectable()
export class WmsEventIntakeService {
  private readonly logger = new Logger(WmsEventIntakeService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WMS_EVENT_QUEUE)
    private readonly queue: WmsEventQueue,
  ) {}

  async recordDelivery(
    input: RecordWmsDeliveryInput,
  ): Promise<RecordedWmsDelivery> {
    // Warehouse identity → candidate connections. This lookup is
    // necessarily cross-tenant (the delivery names no tenant); the secret
    // check below is what authenticates which connection it belongs to.
    const candidates = await this.prisma.runAsSystem(() =>
      this.prisma.wmsConnection.findMany({
        where: {
          provider: input.adapter.provider,
          externalWarehouseId: input.envelope.externalWarehouseId,
        },
      }),
    );

    let connection: (typeof candidates)[number] | undefined;
    let verified = false;

    for (const candidate of candidates) {
      try {
        await input.adapter.verifyInbound({
          rawBody: input.rawBody,
          headers: input.headers,
          envelope: input.envelope,
          connection: {
            id: candidate.id,
            encryptedWebhookSecret: candidate.encryptedWebhookSecret,
          },
        });

        connection = candidate;
        verified = true;
        break;
      } catch {
        // Try the next candidate; only a full match is accepted.
      }
    }

    if (!verified || !connection) {
      this.logger.warn(
        `Rejected WMS delivery for unknown or unauthenticated warehouse ${input.envelope.externalWarehouseId} (event ${input.envelope.externalEventId})`,
      );

      throw new UnauthorizedException("Invalid WMS webhook signature");
    }

    const eventType = extractEventType(input.payload);

    if (!eventType) {
      throw new UnauthorizedException("WMS event payload is missing eventType");
    }

    const recorded = await this.prisma.runAsSystem(() =>
      this.recordEvent({
        tenantId: connection.tenantId,
        connectionId: connection.id,
        externalEventId: input.envelope.externalEventId,
        eventType,
        payload: input.payload,
        payloadSha256: input.payloadSha256,
      }),
    );

    return recorded;
  }

  private async recordEvent(input: {
    tenantId: string;
    connectionId: string;
    externalEventId: string;
    eventType: string;
    payload: Prisma.InputJsonValue;
    payloadSha256: string;
  }): Promise<RecordedWmsDelivery> {
    try {
      const created = await this.prisma.wmsEvent.create({
        data: {
          tenantId: input.tenantId,
          connectionId: input.connectionId,
          externalEventId: input.externalEventId,
          eventType: input.eventType,
          payload: input.payload,
          payloadSha256: input.payloadSha256,
          status: WebhookStatus.RECEIVED,
        },
      });

      return {
        wmsEventId: created.id,
        shouldEnqueue: true,
        resetForRetry: false,
      };
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
    }

    // Duplicate delivery of the same (connection, externalEventId).
    const existing = await this.prisma.wmsEvent.findUnique({
      where: {
        connectionId_externalEventId: {
          connectionId: input.connectionId,
          externalEventId: input.externalEventId,
        },
      },
    });

    if (!existing) {
      throw new Error(
        `WMS event disappeared after unique violation: ${input.externalEventId}`,
      );
    }

    if (
      existing.status === WebhookStatus.PROCESSING ||
      existing.status === WebhookStatus.PROCESSED ||
      existing.status === WebhookStatus.DEAD_LETTER
    ) {
      return {
        wmsEventId: existing.id,
        shouldEnqueue: false,
        resetForRetry: false,
      };
    }

    // FAILED (or still RECEIVED with a stale job): allow one re-enqueue.
    if (existing.status === WebhookStatus.FAILED) {
      await this.prisma.wmsEvent.update({
        where: { id: existing.id },
        data: { status: WebhookStatus.RECEIVED },
      });

      return {
        wmsEventId: existing.id,
        shouldEnqueue: true,
        resetForRetry: true,
      };
    }

    return {
      wmsEventId: existing.id,
      shouldEnqueue: true,
      resetForRetry: false,
    };
  }

  /**
   * Store-then-queue under a deadline (mirrors WebhookIntakeService):
   * the caller answers 503 when queueing fails so the WMS retries the
   * delivery, and the durable row makes the retry safe.
   */
  async recordAndQueue(
    input: RecordWmsDeliveryInput,
  ): Promise<RecordedWmsDelivery> {
    const recorded = await this.recordDelivery(input);

    if (!recorded.shouldEnqueue) {
      this.logger.log(
        `WMS event ${recorded.wmsEventId} already in flight or processed; acknowledged without re-queueing`,
      );

      return recorded;
    }

    const timeoutMs = Number(
      process.env.WEBHOOK_ENQUEUE_TIMEOUT_MS ?? "250",
    );

    try {
      const enqueue = recorded.resetForRetry
        ? this.queue.requeue(recorded.wmsEventId)
        : this.queue.enqueue(recorded.wmsEventId);

      await withTimeout(enqueue, timeoutMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      await this.prisma.wmsEvent.update({
        where: { id: recorded.wmsEventId },
        data: {
          status: WebhookStatus.FAILED,
          lastError: `WMS event stored but not queued: ${message}`,
        },
      });

      this.logger.error(
        `WMS event ${recorded.wmsEventId} stored but not queued: ${message}`,
      );

      throw new ServiceUnavailableException(
        `WMS event stored but not queued: ${message}`,
      );
    }

    return recorded;
  }
}

function extractEventType(payload: Prisma.InputJsonValue): string | null {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const eventType = (payload as Record<string, unknown>).eventType;

    if (typeof eventType === "string" && eventType.trim() !== "") {
      return eventType;
    }
  }

  return null;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `queueing exceeded ${timeoutMs}ms (is Redis reachable?)`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, WebhookStatus } from "@prisma/client";

import {
  ChannelConnector,
  DeliveryEnvelope,
  ReadEnvelopeHeaders,
} from "../connectors/connector.interface";
import { PrismaService } from "../prisma/prisma.service";
import { WebhookQueueService } from "../queue/webhook.queue";

export type RecordDeliveryInput = {
  /** The channel connector that owns this delivery's auth and vocabulary. */
  connector: ChannelConnector;
  /** Delivery identity, already extracted and validated by the connector. */
  envelope: DeliveryEnvelope;
  /** Raw headers, passed through so the connector can verify the signature. */
  headers: ReadEnvelopeHeaders;
  payload: Prisma.InputJsonValue;
  payloadSha256: string;
  /** Raw request body — the signature is computed over these exact bytes. */
  rawBody: Buffer;
};

export type RecordedDelivery = {
  webhookEventId: string;
  /**
   * false when the event is already PROCESSING/PROCESSED, or when it was
   * accepted while a previous job for it is still in Redis. Nothing to
   * enqueue in those cases.
   */
  shouldEnqueue: boolean;
  /**
   * true when the event had previously failed and is being reset for a
   * retry; the stale BullMQ job (if any) has to be removed first, or the
   * re-add would be ignored because job ids deduplicate.
   */
  resetForRetry: boolean;
};

/**
 * Durable intake for channel webhook deliveries (Shopify today).
 *
 * Two production behaviours live here, deliberately:
 *
 * 1. **Verify against the right secret, then persist before acknowledging.**
 *    The store is resolved from the delivery's store identity first, because
 *    the signing secret belongs to the app installed on *that* store. The
 *    channel connector performs the verification; a delivery that fails is
 *    rejected without being stored — an unauthenticated payload must not
 *    become replayable work. Once verified, the event row is written before
 *    queueing, so a delivery is never lost just because the queue is
 *    unhealthy; the payload stays queryable for replay.
 * 2. **Bounded enqueue.** `queue.add` against an unreachable Redis
 *    queues the command indefinitely (ioredis is configured with
 *    `maxRetriesPerRequest: null` for BullMQ), which would hold the HTTP
 *    request open past Shopify's 5-second limit and, repeated often
 *    enough, get the subscription removed. Enqueueing therefore runs
 *    under a deadline; on failure the event is marked FAILED (with the
 *    reason) and the caller answers 503 so Shopify retries with backoff.
 */
@Injectable()
export class WebhookIntakeService {
  private readonly logger = new Logger(WebhookIntakeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: WebhookQueueService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Resolves the tenant from the delivery's store identity and stores the
   * delivery. This is inherently cross-tenant work: which tenant owns a
   * delivery is exactly what the lookup discovers, so it runs before any
   * tenant context exists.
   */
  async recordDelivery(
    input: RecordDeliveryInput,
  ): Promise<RecordedDelivery> {
    return this.prisma.runAsSystem(async () => {
      const store = await this.prisma.storeConnection.findUnique({
        where: {
          platform_externalStoreId: {
            platform: input.connector.platform,
            externalStoreId: input.envelope.storeKey,
          },
        },
      });

      // Unknown store: there is no secret to verify against, so the payload
      // cannot be authenticated and must not be stored or replayable.
      if (!store) {
        this.logger.warn(
          `Rejected delivery for unknown shop ${input.envelope.storeKey} (topic ${input.envelope.topic})`,
        );
        throw new UnauthorizedException("Unknown Shopify shop");
      }

      await input.connector.verifyDelivery({
        rawBody: input.rawBody,
        headers: input.headers,
        store: {
          id: store.id,
          encryptedWebhookSecret: store.encryptedWebhookSecret,
        },
        envelope: input.envelope,
      });

      const webhookEvent = await this.prisma.webhookEvent.upsert({
        where: {
          storeId_externalEventId: {
            storeId: store.id,
            externalEventId: input.envelope.externalEventId,
          },
        },

        create: {
          tenantId: store.tenantId,
          storeId: store.id,
          topic: input.envelope.topic,
          externalEventId: input.envelope.externalEventId,
          payload: input.payload,
          payloadSha256: input.payloadSha256,
          status: WebhookStatus.RECEIVED,
          attempts: 0,
        },

        // Duplicate deliveries must not resurrect processed work; the
        // reset below is scoped to events that actually failed.
        update: {},
      });

      const resetForRetry = webhookEvent.status === WebhookStatus.FAILED;

      if (resetForRetry) {
        await this.prisma.webhookEvent.update({
          where: { id: webhookEvent.id },
          data: {
            status: WebhookStatus.RECEIVED,
            attempts: 0,
            lastError: null,
          },
        });
      }

      const shouldEnqueue =
        resetForRetry || webhookEvent.status === WebhookStatus.RECEIVED;

      if (!shouldEnqueue) {
        this.logger.log(
          `Webhook ${webhookEvent.id} is ${webhookEvent.status}; acknowledged without re-queueing`,
        );
      }

      return {
        webhookEventId: webhookEvent.id,
        shouldEnqueue,
        resetForRetry,
      };
    });
  }

  async enqueueForProcessing(delivery: RecordedDelivery): Promise<void> {
    if (!delivery.shouldEnqueue) {
      return;
    }

    const timeoutMs = this.configService.get<number>(
      "WEBHOOK_ENQUEUE_TIMEOUT_MS",
    ) ?? 4000;

    try {
      await this.withDeadline(
        delivery.resetForRetry
          ? this.queue.requeue(delivery.webhookEventId)
          : this.queue.enqueue(delivery.webhookEventId),
        timeoutMs,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      // The body is already durable; record why it is not queued so the
      // replay tooling (and the webhook health view) can find it.
      await this.markFailed(delivery.webhookEventId, reason);

      this.logger.error(
        `Webhook ${delivery.webhookEventId} stored but not queued: ${reason}`,
      );

      throw new ServiceUnavailableException(
        "Webhook stored but queueing failed; retry the delivery",
      );
    }
  }

  private async withDeadline<T>(
    operation: Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;

    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
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
      if (timer) clearTimeout(timer);

      // A rejected/timed-out promise must not surface as an unhandled
      // rejection later: the queue may still resolve after the deadline.
      operation.catch(() => undefined);
    }
  }

  private async markFailed(
    webhookEventId: string,
    reason: string,
  ): Promise<void> {
    try {
      await this.prisma.runAsSystem(() =>
        this.prisma.webhookEvent.update({
          where: { id: webhookEventId },
          data: {
            status: WebhookStatus.FAILED,
            lastError: reason.slice(0, 500),
          },
        }),
      );
    } catch (error) {
      this.logger.error(
        `Failed to record queueing failure for webhook ${webhookEventId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

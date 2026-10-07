import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, WebhookStatus } from "@prisma/client";

import { decryptSecret } from "../shopify/shopify-auth.crypto";
import { verifyShopifyWebhook } from "./shopify-signature";
import { PrismaService } from "../prisma/prisma.service";
import { WebhookQueueService } from "../queue/webhook.queue";

export type RecordShopifyDeliveryInput = {
  shopDomain: string;
  webhookId: string;
  topic: string;
  payload: Prisma.InputJsonValue;
  payloadSha256: string;
  /** Raw request body — the HMAC is computed over these exact bytes. */
  rawBody: Buffer;
  signature?: string | undefined;
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
 * Durable intake for Shopify (and later, other channel) webhook
 * deliveries.
 *
 * Two production behaviours live here, deliberately:
 *
 * 1. **Verify against the right secret, then persist before acknowledging.**
 *    The store is resolved from the shop domain first, because the signing
 *    secret belongs to the app installed on *that* store: a deployment-wide
 *    secret only works when one app serves every store (OAuth). Custom apps
 *    each have their own secret, so the secret is read per store, falling
 *    back to `SHOPIFY_WEBHOOK_SECRET`. A delivery that fails verification is
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
   * Resolves the tenant from the shop domain and stores the delivery.
   * This is inherently cross-tenant work: which tenant owns a delivery is
   * exactly what the lookup discovers, so it runs before any tenant
   * context exists.
   */
  async recordShopifyDelivery(
    input: RecordShopifyDeliveryInput,
  ): Promise<RecordedDelivery> {
    return this.prisma.runAsSystem(async () => {
      const store = await this.prisma.storeConnection.findUnique({
        where: { shopDomain: input.shopDomain },
      });

      // Unknown shop: there is no secret to verify against, so the payload
      // cannot be authenticated and must not be stored or replayed.
      if (!store) {
        this.logger.warn(
          `Rejected delivery for unknown shop ${input.shopDomain} (topic ${input.topic})`,
        );
        throw new UnauthorizedException("Unknown Shopify shop");
      }

      await this.verifySignature(store, input);

      const webhookEvent = await this.prisma.webhookEvent.upsert({
        where: {
          storeId_shopifyEventId: {
            storeId: store.id,
            shopifyEventId: input.webhookId,
          },
        },

        create: {
          tenantId: store.tenantId,
          storeId: store.id,
          topic: input.topic,
          shopifyEventId: input.webhookId,
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

  /**
   * Authenticates one delivery against the secret that belongs to the app
   * installed on this store.
   *
   * Order matters and is intentional: a store-specific secret wins over the
   * deployment-wide one, and a store-specific secret that does not match is
   * *not* retried against the environment secret. Falling back after a
   * mismatch would turn "someone rotated the secret in Shopify" into a
   * confusing half-working state instead of a clear 401 in the logs plus the
   * sentence below.
   */
  private async verifySignature(
    store: { id: string; encryptedWebhookSecret: string | null },
    input: RecordShopifyDeliveryInput,
  ): Promise<void> {
    let secret: string;
    let source: "store" | "environment";

    if (store.encryptedWebhookSecret) {
      const encryptionKey = this.configService.get<string>("ENCRYPTION_KEY");

      if (!encryptionKey) {
        throw new Error(
          "ENCRYPTION_KEY is not configured, so the store's webhook secret cannot be decrypted",
        );
      }

      try {
        secret = decryptSecret(store.encryptedWebhookSecret, encryptionKey);
      } catch {
        throw new Error(
          `The stored webhook secret for store ${store.id} cannot be decrypted with the current ENCRYPTION_KEY. Reconnect the store (connect-shopify-store.ts) with the right key.`,
        );
      }

      source = "store";
    } else {
      const environmentSecret =
        this.configService.get<string>("SHOPIFY_WEBHOOK_SECRET");

      if (!environmentSecret) {
        throw new Error(
          `SHOPIFY_WEBHOOK_SECRET is not configured and store ${store.id} has no stored webhook secret, so deliveries from ${input.shopDomain} cannot be verified`,
        );
      }

      secret = environmentSecret;
      source = "environment";
    }

    if (!verifyShopifyWebhook(input.rawBody, input.signature, secret)) {
      this.logger.warn(
        `Rejected ${input.topic} from ${input.shopDomain}: HMAC did not match the ${
          source === "store"
            ? "store-specific secret"
            : "deployment-wide SHOPIFY_WEBHOOK_SECRET"
        }. If the secret was rotated in Shopify, reconnect or update the store connection.`,
      );

      throw new UnauthorizedException("Invalid Shopify webhook signature");
    }
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

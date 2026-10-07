import { Injectable, Logger } from "@nestjs/common";
import {
  AuditActorType,
  ExceptionSeverity,
  WebhookStatus,
} from "@prisma/client";

import { PrismaService } from "../../prisma/prisma.service";
import { OrderService } from "../../oms/order/order.service";
import { AuditService } from "../../oms/audit/audit.service";
import { ExceptionService } from "../../oms/exception/exception.service";
import { ResolutionService } from "../../oms/resolution/resolution.service";
import { OrderBusinessFailureError } from "../../oms/order/order-business-failure.error";

export type WebhookProcessingOptions = {
  attempt: number;
  maxAttempts: number;
};

@Injectable()
export class WebhookProcessorService {
  private readonly logger = new Logger(WebhookProcessorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orderService: OrderService,
    private readonly auditService: AuditService,
    private readonly exceptionService: ExceptionService,
    private readonly resolutionService: ResolutionService,
  ) {}

  async processEvent(
    webhookEventId: string,
    options: WebhookProcessingOptions = {
      attempt: 1,
      maxAttempts: 5,
    },
  ): Promise<void> {
    // Which tenant a webhook belongs to is exactly what claiming it
    // discovers — this lookup necessarily runs before any tenant
    // context exists.
    const event = await this.prisma.runAsSystem(async () => {
      const claimed = await this.prisma.webhookEvent.updateMany({
        where: {
          id: webhookEventId,
          status: WebhookStatus.RECEIVED,
        },
        data: {
          status: WebhookStatus.PROCESSING,
        },
      });

      if (claimed.count !== 1) {
        this.logger.debug(
          `Webhook ${webhookEventId} was already claimed or processed`,
        );

        return null;
      }

      const found = await this.prisma.webhookEvent.findUnique({
        where: {
          id: webhookEventId,
        },
      });

      if (!found) {
        throw new Error(`Webhook event not found: ${webhookEventId}`);
      }

      return found;
    });

    if (!event) {
      return;
    }

    // Everything from here on is scoped to the tenant this webhook
    // actually belongs to, now that we know it.
    return this.prisma.runAsTenant(event.tenantId, () =>
      this.processClaimedEvent(event, options),
    );
  }

  private async processClaimedEvent(
    event: {
      id: string;
      tenantId: string;
      storeId: string;
      topic: string;
      shopifyEventId: string;
      payload: unknown;
    },
    options: WebhookProcessingOptions,
  ): Promise<void> {
    const webhookEventId = event.id;

    await this.auditService.recordEvent({
      tenantId: event.tenantId,
      storeId: event.storeId,
      action: "WEBHOOK_PROCESSING_STARTED",
      actorType: AuditActorType.INTEGRATION,
      entityType: "WEBHOOK_EVENT",
      entityId: event.id,
      metadata: {
        topic: event.topic,
        shopifyEventId: event.shopifyEventId,
        attempt: options.attempt,
        maxAttempts: options.maxAttempts,
      },
    });

    try {
      if (event.topic !== "orders/create") {
        await this.prisma.webhookEvent.update({
          where: {
            id: event.id,
          },
          data: {
            status: WebhookStatus.PROCESSED,
            processedAt: new Date(),
            lastError: null,
          },
        });

        await this.auditService.recordEvent({
          tenantId: event.tenantId,
          storeId: event.storeId,
          action: "WEBHOOK_IGNORED",
          actorType: AuditActorType.INTEGRATION,
          entityType: "WEBHOOK_EVENT",
          entityId: event.id,
          metadata: {
            topic: event.topic,
            reason: "Unsupported webhook topic",
          },
        });

        return;
      }

      const order = await this.processOrderCreate(event);

      await this.prisma.webhookEvent.update({
        where: {
          id: event.id,
        },
        data: {
          status: WebhookStatus.PROCESSED,
          processedAt: new Date(),
          lastError: null,
        },
      });

      await this.auditService.recordEvent({
        tenantId: event.tenantId,
        storeId: event.storeId,
        action: "WEBHOOK_PROCESSED",
        actorType: AuditActorType.INTEGRATION,
        entityType: "WEBHOOK_EVENT",
        entityId: event.id,
        metadata: {
          topic: event.topic,
          shopifyEventId: event.shopifyEventId,
          orderId: order.id,
          externalOrderId: order.externalOrderId,
        },
      });

      await this.auditService.recordEvent({
        tenantId: event.tenantId,
        storeId: event.storeId,
        action: "ORDER_SYNCED_FROM_SHOPIFY",
        actorType: AuditActorType.INTEGRATION,
        entityType: "ORDER",
        entityId: order.id,
        metadata: {
          source: "shopify",
          webhookEventId: event.id,
          shopifyEventId: event.shopifyEventId,
          externalOrderId: order.externalOrderId,
          orderNumber: order.orderNumber,
          status: order.status,
        },
      });

      this.logger.log(`Webhook ${event.id} processed successfully`);
    } catch (error) {
      if (error instanceof OrderBusinessFailureError) {
        await this.prisma.webhookEvent.update({
          where: {
            id: event.id,
          },
          data: {
            status: WebhookStatus.PROCESSED,
            processedAt: new Date(),
            lastError: null,
          },
        });

        await this.auditService.recordEvent({
          tenantId: event.tenantId,
          storeId: event.storeId,
          action: "WEBHOOK_BUSINESS_FAILURE_HANDLED",
          actorType: AuditActorType.INTEGRATION,
          entityType: "WEBHOOK_EVENT",
          entityId: event.id,
          metadata: {
            topic: event.topic,
            shopifyEventId: event.shopifyEventId,
            error: error.message,
            exceptionId: error.exceptionId,
            orderId: error.orderId,
            attempt: options.attempt,
            maxAttempts: options.maxAttempts,
            terminal: true,
            reason: "Order business failure was persisted as an operational exception.",
          },
        });

        // Autonomous recovery is deliberately delegated to ResolutionService.
        // ResolutionService remains the safety boundary: unsupported actions
        // remain unresolved, while approved actions execute and verify state.
        await this.resolutionService.claim({
          tenantId: event.tenantId,
          storeId: event.storeId,
          exceptionId: error.exceptionId,
          actorType: AuditActorType.SYSTEM,
          actorId: "webhook-autorecovery",
        });

        const resolution = await this.resolutionService.resolve({
          tenantId: event.tenantId,
          storeId: event.storeId,
          exceptionId: error.exceptionId,
        });

        await this.auditService.recordEvent({
          tenantId: event.tenantId,
          storeId: event.storeId,
          action: "WEBHOOK_AUTONOMOUS_RECOVERY_COMPLETED",
          actorType: AuditActorType.SYSTEM,
          entityType: "OPERATIONAL_EXCEPTION",
          entityId: error.exceptionId,
          metadata: {
            orderId: error.orderId,
            action: resolution.action,
            executed: resolution.executed,
            verified: resolution.verified,
            resolved: resolution.resolved,
            reason: resolution.reason,
          },
        });

        this.logger.warn(
          `Webhook ${webhookEventId} completed with terminal business failure: ${error.message}; autonomous recovery result=${resolution.action}/${resolution.resolved}`,
        );

        return;
      }

      const message = error instanceof Error ? error.message : String(error);

      const finalAttempt = options.attempt >= options.maxAttempts;

      await this.prisma.webhookEvent.update({
        where: {
          id: webhookEventId,
        },
        data: {
          status: finalAttempt
            ? WebhookStatus.DEAD_LETTER
            : WebhookStatus.RECEIVED,
          attempts: {
            increment: 1,
          },
          lastError: message,
        },
      });

      await this.exceptionService.createOrUpdateException({
        tenantId: event.tenantId,
        storeId: event.storeId,
        fingerprint: `WEBHOOK:${event.storeId}:${event.topic}:${event.shopifyEventId}`,
        category: "WEBHOOK_PROCESSING",
        severity: ExceptionSeverity.HIGH,
        title: `Shopify webhook processing failed: ${event.topic}`,
        evidence: {
          webhookEventId: event.id,
          shopifyEventId: event.shopifyEventId,
          topic: event.topic,
          error: message,
          attempt: options.attempt,
          maxAttempts: options.maxAttempts,
          terminal: finalAttempt,
        },
        recommendedNextStep: finalAttempt
          ? "Inspect the webhook payload and processing error. This webhook has exhausted automatic retries and requires manual investigation or replay."
          : "The webhook processing failed transiently. BullMQ will retry the event automatically.",
      });

      await this.auditService.recordEvent({
        tenantId: event.tenantId,
        storeId: event.storeId,
        action: finalAttempt
          ? "WEBHOOK_DEAD_LETTERED"
          : "WEBHOOK_RETRY_SCHEDULED",
        actorType: AuditActorType.INTEGRATION,
        entityType: "WEBHOOK_EVENT",
        entityId: event.id,
        metadata: {
          topic: event.topic,
          shopifyEventId: event.shopifyEventId,
          error: message,
          attempt: options.attempt,
          maxAttempts: options.maxAttempts,
          terminal: finalAttempt,
        },
      });

      this.logger.error(
        `Webhook ${webhookEventId} processing failed on attempt ${options.attempt}/${options.maxAttempts}: ${message}`,
      );

      /*
       * Critical:
       *
       * The worker must receive the error so BullMQ knows the job
       * failed and can apply its configured retry/backoff policy.
       */
      throw error;
    }
  }

  private async processOrderCreate(event: {
    id: string;
    tenantId: string;
    storeId: string;
    shopifyEventId: string;
    payload: unknown;
  }) {
    const payload = event.payload as Record<string, unknown>;

    const shopifyOrderId = this.requireShopifyId(payload.id, "order.id");

    const orderName =
      typeof payload.name === "string" ? payload.name : shopifyOrderId;

    const financialStatus =
      typeof payload.financial_status === "string"
        ? payload.financial_status
        : "unknown";

    const fulfillmentStatus =
      typeof payload.fulfillment_status === "string"
        ? payload.fulfillment_status
        : "unfulfilled";

    const createdAtShopify = this.requireDate(
      payload.created_at,
      "order.created_at",
    );

    const updatedAtShopify = this.requireDate(
      payload.updated_at,
      "order.updated_at",
    );

    await this.prisma.shopifyOrderSnapshot.upsert({
      where: {
        storeId_shopifyOrderId: {
          storeId: event.storeId,
          shopifyOrderId,
        },
      },
      create: {
        tenantId: event.tenantId,
        storeId: event.storeId,
        shopifyOrderId,
        orderName,
        financialStatus,
        fulfillmentStatus,
        raw: payload as any,
        createdAtShopify,
        updatedAtShopify,
      },
      update: {
        orderName,
        financialStatus,
        fulfillmentStatus,
        raw: payload as any,
        updatedAtShopify,
      },
    });

    return this.orderService.upsertFromShopify({
      tenantId: event.tenantId,
      storeId: event.storeId,
      payload,
    });
  }

  private requireShopifyId(value: unknown, field: string): string {
    if (
      (typeof value !== "string" && typeof value !== "number") ||
      String(value).trim() === ""
    ) {
      throw new Error(`Missing required Shopify field: ${field}`);
    }

    return String(value);
  }

  private requireDate(value: unknown, field: string): Date {
    if (typeof value !== "string" && !(value instanceof Date)) {
      throw new Error(`Missing required Shopify field: ${field}`);
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      throw new Error(`Invalid Shopify date: ${field}`);
    }

    return date;
  }
}




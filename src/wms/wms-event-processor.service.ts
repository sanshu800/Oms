import { Injectable, Logger } from "@nestjs/common";
import {
  AuditActorType,
  FulfillmentStatus,
  StoreConnectionStatus,
  WebhookStatus,
  WmsRequestStatus,
} from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../oms/audit/audit.service";
import { FulfillmentService } from "../oms/fulfillment/fulfillment.service";

import { WmsInboundEventPayload } from "./wms-contract";
import {
  WmsEffect,
  describeIllegalTransition,
  isLegalWmsTransition,
  resolveWmsEffect,
} from "./wms-status-mapping";

export type WmsEventProcessingOptions = {
  attempt: number;
  maxAttempts: number;
};

/**
 * A durably-recorded-but-not-applied outcome: unknown event type, invalid
 * transition, stale or invalid quantities, foreign request reference.
 * Rejections are terminal (no retry) and NEVER mutate domain state — the
 * event row keeps the reason so nothing is silent.
 */
export class WmsEventRejectionError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "WmsEventRejectionError";
  }
}

/**
 * Inbound side of the WMS boundary (WMS → TechMart).
 *
 * Applies warehouse events to canonical fulfillment/shipment state
 * through the existing FulfillmentService — this service owns no domain
 * state machines of its own. Every apply step is individually idempotent
 * (cumulative SETs for pick/pack progress, key-matched creates for
 * shipments, early-return transitions in FulfillmentService), so worker
 * retries and duplicate deliveries converge instead of double-applying.
 *
 * Everything runs under the event's tenant (`runAsTenant`) after the
 * claim discovers which tenant that is — the same RLS posture as the
 * webhook processor. Cross-tenant references are rejected: a request
 * found on this connection but belonging to another tenant is recorded
 * as a rejection, never applied.
 */
@Injectable()
export class WmsEventProcessorService {
  private readonly logger = new Logger(WmsEventProcessorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fulfillmentService: FulfillmentService,
    private readonly auditService: AuditService,
  ) {}

  async processEvent(
    wmsEventId: string,
    options: WmsEventProcessingOptions = { attempt: 1, maxAttempts: 5 },
  ): Promise<void> {
    // Which tenant an event belongs to is exactly what claiming it
    // discovers — this lookup necessarily runs before any tenant context.
    const event = await this.prisma.runAsSystem(async () => {
      const claimed = await this.prisma.wmsEvent.updateMany({
        where: {
          id: wmsEventId,
          status: WebhookStatus.RECEIVED,
        },
        data: {
          status: WebhookStatus.PROCESSING,
        },
      });

      if (claimed.count !== 1) {
        this.logger.debug(
          `WMS event ${wmsEventId} was already claimed or processed`,
        );

        return null;
      }

      const found = await this.prisma.wmsEvent.findUnique({
        where: { id: wmsEventId },
      });

      if (!found) {
        throw new Error(`WMS event not found: ${wmsEventId}`);
      }

      return found;
    });

    if (!event) {
      return;
    }

    return this.prisma.runAsTenant(event.tenantId, () =>
      this.processClaimedEvent(event, options),
    );
  }

  private async processClaimedEvent(
    event: {
      id: string;
      tenantId: string;
      connectionId: string;
      eventType: string;
      externalEventId: string;
      payload: unknown;
    },
    options: WmsEventProcessingOptions,
  ): Promise<void> {
    // AuditEvent rows require a storeId (UUID); until the event is
    // correlated to a request we can only record on the event row itself.
    let storeIdForAudit: string | null = null;

    try {
      const connection = await this.prisma.wmsConnection.findUnique({
        where: { id: event.connectionId },
        select: { id: true, status: true, tenantId: true },
      });

      if (!connection) {
        throw new Error(
          `WMS connection not found for event: ${event.id}`,
        );
      }

      // A disconnected warehouse's in-flight events must not be applied
      // against a dead connection (same rule as channel webhooks).
      if (connection.status !== StoreConnectionStatus.ACTIVE) {
        await this.finishAsIgnored(
          event,
          `WMS connection is ${connection.status}`,
        );

        return;
      }

      const effect = resolveWmsEffect(event.eventType);

      if (!effect) {
        await this.reject(event, `Unknown WMS event type: ${event.eventType}`);

        return;
      }

      const payload = this.parsePayload(event);

      const request = await this.prisma.wmsFulfillmentRequest.findUnique({
        where: {
          connectionId_idempotencyKey: {
            connectionId: event.connectionId,
            idempotencyKey: payload.requestRef,
          },
        },
        include: {
          lines: true,
        },
      });

      if (!request) {
        await this.reject(
          event,
          `WMS event references unknown request ${payload.requestRef} on connection ${event.connectionId}`,
        );

        return;
      }

      // Tenant ownership: the event row's tenant (discovered at intake by
      // secret verification) must match the request's tenant. A foreign
      // request reference is rejected, never applied.
      if (request.tenantId !== event.tenantId) {
        await this.reject(
          event,
          `WMS event ${event.externalEventId} references request ${request.id} owned by a different tenant`,
        );

        return;
      }

      storeIdForAudit = request.storeId;

      await this.auditService.recordEvent({
        tenantId: event.tenantId,
        storeId: request.storeId,
        action: "WMS_EVENT_PROCESSING_STARTED",
        actorType: AuditActorType.INTEGRATION,
        entityType: "WMS_EVENT",
        entityId: event.id,
        metadata: {
          eventType: event.eventType,
          externalEventId: event.externalEventId,
          attempt: options.attempt,
          maxAttempts: options.maxAttempts,
        },
      });

      // Identity check before ANY mutation: the request's registered
      // external id must match what the event claims.
      if (
        payload.externalRequestId &&
        request.externalRequestId &&
        payload.externalRequestId !== request.externalRequestId
      ) {
        throw new WmsEventRejectionError(
          `WMS event carries externalRequestId ${payload.externalRequestId} but request ${request.id} is registered as ${request.externalRequestId}`,
        );
      }

      // Correlate for traceability (nullable FK set once resolved).
      await this.prisma.wmsEvent.update({
        where: { id: event.id },
        data: { requestId: request.id },
      });

      const fulfillment = await this.fulfillmentService.getById({
        tenantId: event.tenantId,
        storeId: request.storeId,
        fulfillmentId: request.fulfillmentId,
      });

      if (!isLegalWmsTransition(effect, fulfillment.status)) {
        await this.reject(
          event,
          describeIllegalTransition(effect, fulfillment.status),
          request.storeId,
        );

        return;
      }

      this.validateQuantities(effect, payload, request.lines);

      await this.apply(effect, event, payload, request, fulfillment);

      await this.markProcessed(event.id);

      await this.auditService.recordEvent({
        tenantId: event.tenantId,
        storeId: request.storeId,
        action: "WMS_EVENT_APPLIED",
        actorType: AuditActorType.INTEGRATION,
        entityType: "WMS_EVENT",
        entityId: event.id,
        metadata: {
          eventType: event.eventType,
          externalEventId: event.externalEventId,
          effect: effect.kind,
          requestId: request.id,
          fulfillmentId: fulfillment.id,
        },
      });

      this.logger.log(
        `WMS event ${event.id} (${event.eventType}) applied to fulfillment ${fulfillment.id}`,
      );
    } catch (error) {
      if (error instanceof WmsEventRejectionError) {
        await this.reject(event, error.message, storeIdForAudit);

        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      const terminal = options.attempt >= options.maxAttempts;

      await this.prisma.wmsEvent.update({
        where: { id: event.id },
        data: {
          status: terminal
            ? WebhookStatus.DEAD_LETTER
            : WebhookStatus.FAILED,
          attempts: { increment: 1 },
          lastError: message,
        },
      });

      if (storeIdForAudit) {
        await this.auditService.recordEvent({
          tenantId: event.tenantId,
          storeId: storeIdForAudit,
          action: terminal
            ? "WMS_EVENT_DEAD_LETTERED"
            : "WMS_EVENT_PROCESSING_FAILED",
          actorType: AuditActorType.INTEGRATION,
          entityType: "WMS_EVENT",
          entityId: event.id,
          metadata: {
            eventType: event.eventType,
            externalEventId: event.externalEventId,
            error: message,
            attempt: options.attempt,
            maxAttempts: options.maxAttempts,
          },
        });
      }

      this.logger.error(
        `WMS event ${event.id} processing failed on attempt ${options.attempt}/${options.maxAttempts}: ${message}`,
      );

      throw error;
    }
  }

  // ============================================================
  // Validation (all before any mutation)
  // ============================================================

  private parsePayload(event: {
    id: string;
    eventType: string;
    payload: unknown;
  }): WmsInboundEventPayload {
    const payload = event.payload;

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new WmsEventRejectionError("WMS event payload must be an object");
    }

    const raw = payload as Record<string, unknown>;

    if (raw.eventType !== event.eventType) {
      throw new WmsEventRejectionError(
        "WMS event payload eventType does not match the stored event type",
      );
    }

    if (typeof raw.requestRef !== "string" || raw.requestRef.trim() === "") {
      throw new WmsEventRejectionError(
        "WMS event payload is missing requestRef",
      );
    }

    if (typeof raw.occurredAt !== "string" || raw.occurredAt.trim() === "") {
      throw new WmsEventRejectionError(
        "WMS event payload is missing occurredAt",
      );
    }

    if (Number.isNaN(new Date(raw.occurredAt).getTime())) {
      throw new WmsEventRejectionError(
        "WMS event payload has an invalid occurredAt",
      );
    }

    if (raw.lines !== undefined && !Array.isArray(raw.lines)) {
      throw new WmsEventRejectionError("WMS event payload lines must be an array");
    }

    for (const line of (raw.lines as unknown[] | undefined) ?? []) {
      const ref =
        line && typeof line === "object"
          ? (line as Record<string, unknown>).externalLineRef
          : undefined;

      if (typeof ref !== "string" || ref.trim() === "") {
        throw new WmsEventRejectionError(
          "WMS event payload line is missing externalLineRef",
        );
      }
    }

    if (
      raw.shipment !== undefined &&
      (!raw.shipment ||
        typeof raw.shipment !== "object" ||
        Array.isArray(raw.shipment))
    ) {
      throw new WmsEventRejectionError(
        "WMS event payload shipment must be an object",
      );
    }

    return raw as unknown as WmsInboundEventPayload;
  }

  private validateQuantities(
    effect: WmsEffect,
    payload: WmsInboundEventPayload,
    requestLines: Array<{
      id: string;
      externalLineRef: string;
      quantity: number;
      pickedQuantity: number;
      packedQuantity: number;
      shippedQuantity: number;
    }>,
  ): void {
    const lines = payload.lines ?? [];

    if (
      effect.kind === "RECORD_PICK_PROGRESS" ||
      effect.kind === "RECORD_PACK_PROGRESS" ||
      effect.kind === "SHIP_QUANTITIES"
    ) {
      if (lines.length === 0) {
        throw new WmsEventRejectionError(
          `WMS ${effect.kind} event must carry line quantities`,
        );
      }
    }

    if (effect.kind === "SHIP_QUANTITIES") {
      if (!payload.shipment?.externalShipmentId) {
        throw new WmsEventRejectionError(
          "WMS shipped event must carry shipment.externalShipmentId",
        );
      }
    }

    const seen = new Set<string>();

    for (const line of lines) {
      if (seen.has(line.externalLineRef)) {
        throw new WmsEventRejectionError(
          `Duplicate WMS line reference in event: ${line.externalLineRef}`,
        );
      }
      seen.add(line.externalLineRef);

      const requestLine = requestLines.find(
        (candidate) => candidate.externalLineRef === line.externalLineRef,
      );

      if (!requestLine) {
        throw new WmsEventRejectionError(
          `WMS event references unknown line ${line.externalLineRef}`,
        );
      }

      if (!Number.isInteger(line.quantity) || line.quantity < 0) {
        throw new WmsEventRejectionError(
          `Invalid WMS quantity for line ${line.externalLineRef}`,
        );
      }

      if (effect.kind === "SHIP_QUANTITIES") {
        // Per-handover quantities must be positive and must not over-ship
        // what the request asked for (FulfillmentService re-checks against
        // live shipments; this is the fast, reason-bearing rejection).
        if (line.quantity <= 0) {
          throw new WmsEventRejectionError(
            `Invalid WMS ship quantity for line ${line.externalLineRef}`,
          );
        }

        if (requestLine.shippedQuantity + line.quantity > requestLine.quantity) {
          throw new WmsEventRejectionError(
            `WMS ship quantity exceeds remaining request quantity for line ${line.externalLineRef}`,
          );
        }
      } else {
        // Pick/pack are CUMULATIVE stage totals: monotonic and bounded by
        // the requested quantity. A lower total than we already recorded
        // is an out-of-order/stale event — reject, never roll back.
        const current =
          effect.kind === "RECORD_PICK_PROGRESS"
            ? requestLine.pickedQuantity
            : requestLine.packedQuantity;

        if (line.quantity < current) {
          throw new WmsEventRejectionError(
            `Stale WMS ${effect.kind} quantity for line ${line.externalLineRef}: recorded ${current}, event ${line.quantity}`,
          );
        }

        if (line.quantity > requestLine.quantity) {
          throw new WmsEventRejectionError(
            `WMS ${effect.kind} quantity exceeds request quantity for line ${line.externalLineRef}`,
          );
        }
      }
    }
  }

  // ============================================================
  // Apply (idempotent operations only)
  // ============================================================

  private async apply(
    effect: WmsEffect,
    event: { id: string; tenantId: string; externalEventId: string; eventType: string },
    payload: WmsInboundEventPayload,
    request: {
      id: string;
      tenantId: string;
      storeId: string;
      fulfillmentId: string;
      status: WmsRequestStatus;
      externalRequestId: string | null;
      lines: Array<{ id: string; externalLineRef: string; orderItemId: string; quantity: number }>;
    },
    fulfillment: {
      id: string;
      status: FulfillmentStatus;
      items: Array<{ id: string; orderItemId: string; quantity: number }>;
    },
  ): Promise<void> {
    switch (effect.kind) {
      case "START_FULFILLMENT": {
        // Idempotent: FulfillmentService.start early-returns on IN_PROGRESS.
        await this.fulfillmentService.start({
          tenantId: event.tenantId,
          storeId: request.storeId,
          fulfillmentId: fulfillment.id,
        });

        await this.prisma.wmsFulfillmentRequest.update({
          where: { id: request.id },
          data: {
            status: WmsRequestStatus.ACKNOWLEDGED,
            acknowledgedAt: new Date(),
            externalRequestId:
              payload.externalRequestId ?? request.externalRequestId,
            lastError: null,
          },
        });

        break;
      }

      case "RECORD_PICK_PROGRESS": {
        await this.recordStageProgress(
          payload,
          request,
          "pickedQuantity",
        );

        break;
      }

      case "RECORD_PACK_PROGRESS": {
        await this.recordStageProgress(
          payload,
          request,
          "packedQuantity",
        );

        break;
      }

      case "SHIP_QUANTITIES": {
        const shipment = payload.shipment!;

        const items = (payload.lines ?? []).map((line) => {
          const requestLine = request.lines.find(
            (candidate) => candidate.externalLineRef === line.externalLineRef,
          )!;

          const fulfillmentItem = fulfillment.items.find(
            (candidate) => candidate.orderItemId === requestLine.orderItemId,
          );

          if (!fulfillmentItem) {
            throw new WmsEventRejectionError(
              `WMS ship event line ${line.externalLineRef} matches no fulfillment item`,
            );
          }

          return {
            fulfillmentItemId: fulfillmentItem.id,
            quantity: line.quantity,
          };
        });

        // Key-matched create: a replayed event with the same
        // externalShipmentId returns the existing shipment instead of a
        // second one (FulfillmentService enforces).
        const created = await this.fulfillmentService.createShipment({
          tenantId: event.tenantId,
          storeId: request.storeId,
          fulfillmentId: fulfillment.id,
          externalShipmentId: shipment.externalShipmentId,
          carrier: shipment.carrier,
          service: shipment.service,
          trackingNumber: shipment.trackingNumber,
          trackingUrl: shipment.trackingUrl,
          items,
        });

        // Handover to the carrier: IN_TRANSIT. A tracking number alone is
        // never what moves this state — the warehouse handover is.
        await this.fulfillmentService.shipShipment({
          tenantId: event.tenantId,
          storeId: request.storeId,
          shipmentId: created.id,
        });

        // SET (not increment) shipped bookkeeping from the authoritative
        // shipment ledger — replays cannot double-count.
        const shippedByItem =
          await this.fulfillmentService.getShippedQuantityByFulfillmentItem(
            fulfillment.id,
          );

        for (const requestLine of request.lines) {
          const fulfillmentItem = fulfillment.items.find(
            (candidate) => candidate.orderItemId === requestLine.orderItemId,
          );

          if (!fulfillmentItem) {
            continue;
          }

          await this.prisma.wmsFulfillmentRequestLine.update({
            where: { id: requestLine.id },
            data: {
              shippedQuantity: shippedByItem.get(fulfillmentItem.id) ?? 0,
            },
          });
        }

        // PARTIALLY_FULFILLED or FULFILLED (inventory commits on full).
        const completed = await this.fulfillmentService.complete({
          tenantId: event.tenantId,
          storeId: request.storeId,
          fulfillmentId: fulfillment.id,
        });

        await this.prisma.wmsFulfillmentRequest.update({
          where: { id: request.id },
          data:
            completed.status === FulfillmentStatus.FULFILLED
              ? {
                  status: WmsRequestStatus.COMPLETED,
                  completedAt: new Date(),
                  lastError: null,
                }
              : { lastError: null },
        });

        break;
      }

      case "FAIL_FULFILLMENT": {
        await this.fulfillmentService.fail({
          tenantId: event.tenantId,
          storeId: request.storeId,
          fulfillmentId: fulfillment.id,
        });

        await this.prisma.wmsFulfillmentRequest.update({
          where: { id: request.id },
          data: {
            status: WmsRequestStatus.FAILED,
            failedAt: new Date(),
            lastError: payload.failureReason ?? "Warehouse reported failure",
          },
        });

        break;
      }

      case "CANCEL_FULFILLMENT": {
        await this.fulfillmentService.cancel({
          tenantId: event.tenantId,
          storeId: request.storeId,
          fulfillmentId: fulfillment.id,
        });

        await this.prisma.wmsFulfillmentRequest.update({
          where: { id: request.id },
          data: {
            status: WmsRequestStatus.CANCELLED,
            cancelledAt: new Date(),
            lastError: null,
          },
        });

        break;
      }
    }
  }

  /**
   * Cumulative SET of one execution stage. Idempotent on replay; the
   * monotonicity/upper-bound rules were already validated.
   */
  private async recordStageProgress(
    payload: WmsInboundEventPayload,
    request: {
      id: string;
      lines: Array<{ id: string; externalLineRef: string }>;
    },
    field: "pickedQuantity" | "packedQuantity",
  ): Promise<void> {
    for (const line of payload.lines ?? []) {
      const requestLine = request.lines.find(
        (candidate) => candidate.externalLineRef === line.externalLineRef,
      )!;

      await this.prisma.wmsFulfillmentRequestLine.update({
        where: { id: requestLine.id },
        data: { [field]: line.quantity },
      });
    }
  }

  // ============================================================
  // Event row outcomes
  // ============================================================

  private async markProcessed(wmsEventId: string): Promise<void> {
    await this.prisma.wmsEvent.update({
      where: { id: wmsEventId },
      data: {
        status: WebhookStatus.PROCESSED,
        processedAt: new Date(),
        lastError: null,
        rejectionReason: null,
      },
    });
  }

  private async reject(
    event: {
      id: string;
      tenantId: string;
      eventType: string;
      externalEventId: string;
    },
    reason: string,
    storeId: string | null = null,
  ): Promise<void> {
    // Terminal and recorded: no retry, no domain mutation, nothing silent.
    // The durable event row always carries the reason; the audit trail is
    // written once the event is correlated to a store.
    await this.prisma.wmsEvent.update({
      where: { id: event.id },
      data: {
        status: WebhookStatus.PROCESSED,
        processedAt: new Date(),
        lastError: null,
        rejectionReason: reason,
      },
    });

    if (storeId) {
      await this.auditService.recordEvent({
        tenantId: event.tenantId,
        storeId,
        action: "WMS_EVENT_REJECTED",
        actorType: AuditActorType.INTEGRATION,
        entityType: "WMS_EVENT",
        entityId: event.id,
        metadata: {
          eventType: event.eventType,
          externalEventId: event.externalEventId,
          reason,
        },
      });
    }

    this.logger.warn(
      `Rejected WMS event ${event.id} (${event.eventType}): ${reason}`,
    );
  }

  private async finishAsIgnored(
    event: { id: string; eventType: string },
    reason: string,
  ): Promise<void> {
    await this.prisma.wmsEvent.update({
      where: { id: event.id },
      data: {
        status: WebhookStatus.PROCESSED,
        processedAt: new Date(),
        lastError: null,
        rejectionReason: reason,
      },
    });

    this.logger.warn(
      `Ignored WMS event ${event.id} (${event.eventType}): ${reason}`,
    );
  }
}

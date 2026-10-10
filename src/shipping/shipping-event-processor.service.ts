import { Injectable, Logger } from "@nestjs/common";
import {
  AuditActorType,
  FulfillmentStatus,
  ShipmentStatus,
  StoreConnectionStatus,
  WebhookStatus,
} from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../oms/audit/audit.service";
import { FulfillmentService } from "../oms/fulfillment/fulfillment.service";

import {
  ShippingCanonicalAction,
  ShippingInboundEvent,
  ShippingProviderStatus,
} from "./shipping-contract";
import { mapShippingEventToCanonicalAction } from "./shipping-status-mapping";

export type ShippingEventProcessingOptions = {
  attempt: number;
  maxAttempts: number;
};

/**
 * A durably-recorded-but-not-applied outcome: unknown event type, unknown
 * shipment, out-of-order transition, cross-tenant reference, invalid
 * payload. Rejections are terminal (no retry) and NEVER mutate domain
 * state — the event row keeps the reason so nothing is silent.
 */
export class ShippingEventRejectionError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ShippingEventRejectionError";
  }
}

/**
 * Inbound side of the shipping boundary (shipping provider → TechMart).
 *
 * Applies carrier events to canonical shipment state through the existing
 * FulfillmentService — this service owns no domain state machines of its
 * own. Enforced invariants:
 *
 * - Packing, AWB/label generation, and pickup scheduling NEVER mark a
 *   shipment in transit or an order shipped. Only `record_handover_confirmed`
 *   (verified carrier possession) calls `shipShipment`.
 * - Cancellation REQUESTED (soft bookkeeping) and CONFIRMED (`cancelShipment`)
 *   are distinct and never conflated.
 * - Cancellation races: when handover/delivery was already committed and a
 *   cancellation request/confirmation arrives, the verified provider state
 *   is PRESERVED and the shipment is flagged for reconciliation. When
 *   cancellation was committed first and handover/delivery arrives, the
 *   event is quarantined (no mutation) and the shipment is flagged.
 * - Duplicates and replays converge (unique event key + transition-level
 *   early returns + cumulative bookkeeping SETs) — never double-applied.
 *
 * Everything runs under the event's tenant (`runAsTenant`) after the claim
 * discovers which tenant that is — the same RLS posture as the webhook
 * processor. Cross-tenant references are rejected: a shipment belonging to
 * another tenant is recorded as a rejection, never applied.
 */
@Injectable()
export class ShippingEventProcessorService {
  private readonly logger = new Logger(ShippingEventProcessorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fulfillmentService: FulfillmentService,
    private readonly auditService: AuditService,
  ) {}

  async processEvent(
    shippingEventId: string,
    options: ShippingEventProcessingOptions = { attempt: 1, maxAttempts: 5 },
  ): Promise<void> {
    // Which tenant an event belongs to is exactly what claiming it
    // discovers — this lookup necessarily runs before any tenant context.
    const event = await this.prisma.runAsSystem(async () => {
      const claimed = await this.prisma.shippingEvent.updateMany({
        where: {
          id: shippingEventId,
          status: WebhookStatus.RECEIVED,
        },
        data: {
          status: WebhookStatus.PROCESSING,
        },
      });

      if (claimed.count !== 1) {
        this.logger.debug(
          `Shipping event ${shippingEventId} was already claimed or processed`,
        );

        return null;
      }

      const found = await this.prisma.shippingEvent.findUnique({
        where: { id: shippingEventId },
      });

      if (!found) {
        throw new Error(`Shipping event not found: ${shippingEventId}`);
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
    options: ShippingEventProcessingOptions,
  ): Promise<void> {
    // AuditEvent rows require a storeId (UUID); until the event is
    // correlated to a shipment we can only record on the event row itself.
    let storeIdForAudit: string | null = null;

    try {
      const connection = await this.prisma.shippingConnection.findUnique({
        where: { id: event.connectionId },
        select: { id: true, status: true, tenantId: true },
      });

      if (!connection) {
        throw new Error(`Shipping connection not found for event: ${event.id}`);
      }

      // A disconnected account's in-flight events must not be applied
      // against a dead connection (same rule as channel webhooks).
      if (connection.status !== StoreConnectionStatus.ACTIVE) {
        await this.finishAsIgnored(
          event,
          `Shipping connection is ${connection.status}`,
        );

        return;
      }

      const wireEvent = this.parsePayload(event);

      const action = mapShippingEventToCanonicalAction(wireEvent);

      if (action.type === "reject_event") {
        await this.reject(event, action.reason);

        return;
      }

      // Resolve the canonical shipment by provider identity. The lookup
      // runs as system first to DISTINGUISH cross-tenant references from
      // unknown ones — neither is ever applied.
      const found = await this.prisma.runAsSystem(() =>
        this.prisma.shipment.findFirst({
          where: { externalShipmentId: wireEvent.externalShipmentId },
        }),
      );

      if (!found) {
        await this.reject(
          event,
          `Shipping event references unknown shipment ${wireEvent.externalShipmentId}`,
        );

        return;
      }

      if (found.tenantId !== event.tenantId) {
        await this.reject(
          event,
          `Shipping event ${event.externalEventId} references shipment ${found.id} owned by a different tenant`,
        );

        return;
      }

      const shipment = found;
      storeIdForAudit = shipment.storeId;

      await this.auditService.recordEvent({
        tenantId: event.tenantId,
        storeId: shipment.storeId,
        action: "SHIPPING_EVENT_PROCESSING_STARTED",
        actorType: AuditActorType.INTEGRATION,
        entityType: "SHIPPING_EVENT",
        entityId: event.id,
        metadata: {
          eventType: event.eventType,
          externalEventId: event.externalEventId,
          attempt: options.attempt,
          maxAttempts: options.maxAttempts,
        },
      });

      // Correlate for traceability (nullable FK set once resolved).
      if (shipment.id !== (event as { shipmentId?: string | null }).shipmentId) {
        await this.prisma.shippingEvent.update({
          where: { id: event.id },
          data: { shipmentId: shipment.id },
        });
      }

      await this.apply(action, event, wireEvent, {
        id: shipment.id,
        tenantId: shipment.tenantId,
        storeId: shipment.storeId,
        fulfillmentId: shipment.fulfillmentId,
        status: shipment.status as ShipmentStatus,
        cancellationRequestedAt: shipment.cancellationRequestedAt as Date | null,
      });

      await this.markProcessed(event.id);

      await this.auditService.recordEvent({
        tenantId: event.tenantId,
        storeId: shipment.storeId,
        action: "SHIPPING_EVENT_APPLIED",
        actorType: AuditActorType.INTEGRATION,
        entityType: "SHIPPING_EVENT",
        entityId: event.id,
        metadata: {
          eventType: event.eventType,
          externalEventId: event.externalEventId,
          effect: action.type,
          shipmentId: shipment.id,
          externalShipmentId: wireEvent.externalShipmentId,
        },
      });

      this.logger.log(
        `Shipping event ${event.id} (${event.eventType}) applied to shipment ${shipment.id}`,
      );
    } catch (error) {
      if (error instanceof ShippingEventRejectionError) {
        await this.reject(event, error.message, storeIdForAudit);

        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      const terminal = options.attempt >= options.maxAttempts;

      await this.prisma.shippingEvent.update({
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
            ? "SHIPPING_EVENT_DEAD_LETTERED"
            : "SHIPPING_EVENT_PROCESSING_FAILED",
          actorType: AuditActorType.INTEGRATION,
          entityType: "SHIPPING_EVENT",
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
        `Shipping event ${event.id} processing failed on attempt ${options.attempt}/${options.maxAttempts}: ${message}`,
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
    externalEventId: string;
    payload: unknown;
  }): ShippingInboundEvent {
    const payload = event.payload;

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new ShippingEventRejectionError("Shipping event payload must be an object");
    }

    const record = payload as Record<string, unknown>;

    const type = typeof record.type === "string" ? record.type.trim() : "";

    if (!type) {
      throw new ShippingEventRejectionError("Shipping event payload is missing type");
    }

    const externalShipmentId =
      typeof record.externalShipmentId === "string"
        ? record.externalShipmentId.trim()
        : "";

    if (!externalShipmentId) {
      throw new ShippingEventRejectionError(
        "Shipping event payload is missing externalShipmentId",
      );
    }

    const occurredAt =
      typeof record.occurredAt === "string" && record.occurredAt.trim() !== ""
        ? record.occurredAt
        : null;

    if (!occurredAt) {
      throw new ShippingEventRejectionError(
        "Shipping event payload is missing occurredAt",
      );
    }

    const knownStatuses = new Set<string>(
      Object.values(ShippingProviderStatus),
    );

    const rawStatus =
      typeof record.status === "string" ? record.status.trim() : "";
    const status = knownStatuses.has(rawStatus)
      ? (rawStatus as ShippingProviderStatus)
      : ShippingProviderStatus.UNKNOWN;

    return {
      contractVersion:
        typeof record.contractVersion === "string" ? record.contractVersion : "",
      type: type as ShippingInboundEvent["type"],
      externalEventId:
        typeof record.externalEventId === "string"
          ? record.externalEventId
          : event.externalEventId,
      externalShipmentId,
      externalOrderId:
        typeof record.externalOrderId === "string"
          ? record.externalOrderId
          : undefined,
      status,
      awbCode: typeof record.awbCode === "string" ? record.awbCode : undefined,
      courierName:
        typeof record.courierName === "string" ? record.courierName : undefined,
      labelUrl: typeof record.labelUrl === "string" ? record.labelUrl : undefined,
      trackingNumber:
        typeof record.trackingNumber === "string"
          ? record.trackingNumber
          : undefined,
      occurredAt,
    };
  }

  // ============================================================
  // Apply (idempotent operations only)
  // ============================================================

  private async apply(
    action: ShippingCanonicalAction,
    event: { id: string; tenantId: string; eventType: string; externalEventId: string },
    wireEvent: ShippingInboundEvent,
    shipment: {
      id: string;
      tenantId: string;
      storeId: string;
      fulfillmentId: string;
      status: ShipmentStatus;
      cancellationRequestedAt: Date | null;
    },
  ): Promise<void> {
    switch (action.type) {
      case "record_shipment_created": {
        // Bookkeeping only — creation artifacts never change status.
        await this.noteProviderArtifacts(shipment.id, wireEvent);

        break;
      }

      case "record_label_created": {
        await this.noteProviderArtifacts(shipment.id, wireEvent);

        // AWB/label stops at LABEL_CREATED — explicitly not shipped.
        if (shipment.status === ShipmentStatus.CREATED) {
          await this.fulfillmentService.labelShipment({
            tenantId: shipment.tenantId,
            storeId: shipment.storeId,
            shipmentId: shipment.id,
          });
        }

        break;
      }

      case "record_handover_confirmed": {
        if (shipment.status === ShipmentStatus.CANCELLED) {
          // Cancellation was committed first; the carrier now claims
          // possession. Never mutate committed state silently — quarantine
          // the event and flag the discrepancy for reconciliation.
          await this.flagReconciliation(
            shipment,
            event,
            "Carrier handover confirmed for a cancelled shipment",
          );

          throw new ShippingEventRejectionError(
            `Out-of-order shipping event: handover confirmed for cancelled shipment ${shipment.id}`,
          );
        }

        await this.noteProviderArtifacts(shipment.id, wireEvent);

        // ONLY verified carrier handover marks the shipment in transit.
        // Order of domain calls is load-bearing: `complete()` performs the
        // inventory COMMIT (ACTIVE -> COMMITTED) when everything is
        // allocated to shipments, and `shipShipment` performs the inventory
        // SHIP (COMMITTED -> SHIPPED). Committing first is the same
        // sequence the canonical order flow uses (FULFILLING -> FULFILLED);
        // the reverse order would make shipOrder a silent no-op and strand
        // reservations at COMMITTED.
        //
        // Duplicates and already-delivered states converge without
        // re-applying inventory transitions (complete/shipShipment
        // early-return).
        if (
          shipment.status === ShipmentStatus.CREATED ||
          shipment.status === ShipmentStatus.LABEL_CREATED
        ) {
          await this.fulfillmentService.complete({
            tenantId: shipment.tenantId,
            storeId: shipment.storeId,
            fulfillmentId: shipment.fulfillmentId,
          });

          await this.fulfillmentService.shipShipment({
            tenantId: shipment.tenantId,
            storeId: shipment.storeId,
            shipmentId: shipment.id,
          });

          await this.prisma.shipment.update({
            where: { id: shipment.id },
            data: {
              handedOverAt: new Date(wireEvent.occurredAt),
              lastProviderStatus: wireEvent.status,
            },
          });
        }

        break;
      }

      case "record_delivered": {
        if (shipment.status === ShipmentStatus.CANCELLED) {
          await this.flagReconciliation(
            shipment,
            event,
            "Delivery confirmed for a cancelled shipment",
          );

          throw new ShippingEventRejectionError(
            `Out-of-order shipping event: delivery confirmed for cancelled shipment ${shipment.id}`,
          );
        }

        await this.noteProviderArtifacts(shipment.id, wireEvent);

        if (shipment.status === ShipmentStatus.DELIVERED) {
          // Duplicate delivery — already applied.
          break;
        }

        // Delivery is carrier evidence that possession happened: an
        // out-of-order delivery (before any handover event) may pass
        // through IN_TRANSIT, but only ever via verified evidence. The
        // commit-then-ship order matches record_handover_confirmed.
        if (
          shipment.status === ShipmentStatus.CREATED ||
          shipment.status === ShipmentStatus.LABEL_CREATED
        ) {
          await this.fulfillmentService.complete({
            tenantId: shipment.tenantId,
            storeId: shipment.storeId,
            fulfillmentId: shipment.fulfillmentId,
          });

          await this.fulfillmentService.shipShipment({
            tenantId: shipment.tenantId,
            storeId: shipment.storeId,
            shipmentId: shipment.id,
          });

          await this.prisma.shipment.update({
            where: { id: shipment.id },
            data: { handedOverAt: new Date(wireEvent.occurredAt) },
          });
        }

        await this.fulfillmentService.deliverShipment({
          tenantId: shipment.tenantId,
          storeId: shipment.storeId,
          shipmentId: shipment.id,
        });

        await this.prisma.shipment.update({
          where: { id: shipment.id },
          data: {
            deliveredAt: new Date(wireEvent.occurredAt),
            lastProviderStatus: wireEvent.status,
          },
        });

        break;
      }

      case "record_cancellation_requested": {
        // Soft state: bookkeeping only. The shipment's status NEVER
        // changes on a request — only on a confirmed cancellation.
        await this.prisma.shipment.update({
          where: { id: shipment.id },
          data: {
            cancellationRequestedAt:
              shipment.cancellationRequestedAt ?? new Date(wireEvent.occurredAt),
            cancellationRequestRef:
              shipment.cancellationRequestedAt === null
                ? event.externalEventId
                : undefined,
            lastProviderStatus: wireEvent.status,
          },
        });

        if (
          shipment.status === ShipmentStatus.IN_TRANSIT ||
          shipment.status === ShipmentStatus.DELIVERED
        ) {
          // Handover/delivery won the race: preserve the verified
          // provider state and ask for reconciliation.
          await this.flagReconciliation(
            shipment,
            event,
            `Cancellation requested after the shipment was ${shipment.status}`,
          );
        }

        break;
      }

      case "record_cancellation_confirmed": {
        if (shipment.status === ShipmentStatus.CANCELLED) {
          // Duplicate confirmation — already applied.
          break;
        }

        if (
          shipment.status === ShipmentStatus.IN_TRANSIT ||
          shipment.status === ShipmentStatus.DELIVERED
        ) {
          // Handover/delivery won the race: the verified provider state
          // (the carrier HAS the parcel / it WAS delivered) is preserved;
          // a confirmed cancellation after dispatch cannot silently
          // rewrite it. Flag for reconciliation instead.
          await this.prisma.shipment.update({
            where: { id: shipment.id },
            data: {
              cancellationRequestedAt:
                shipment.cancellationRequestedAt ?? new Date(wireEvent.occurredAt),
              lastProviderStatus: wireEvent.status,
            },
          });

          await this.flagReconciliation(
            shipment,
            event,
            `Provider confirmed cancellation after the shipment was ${shipment.status}`,
          );

          break;
        }

        // CREATED / LABEL_CREATED: the confirmed cancellation applies to
        // THIS shipment only.
        await this.prisma.shipment.update({
          where: { id: shipment.id },
          data: {
            cancellationRequestedAt:
              shipment.cancellationRequestedAt ?? new Date(wireEvent.occurredAt),
            cancellationRequestRef:
              shipment.cancellationRequestedAt === null
                ? event.externalEventId
                : undefined,
            lastProviderStatus: wireEvent.status,
          },
        });

        // History-preserving: only the cancelled shipment transitions to
        // CANCELLED. Sibling shipments (including delivered ones) keep
        // their rows, items, and shipped bookkeeping untouched.
        await this.fulfillmentService.cancelShipment({
          tenantId: shipment.tenantId,
          storeId: shipment.storeId,
          shipmentId: shipment.id,
        });

        const fulfillment = await this.fulfillmentService.getById({
          tenantId: shipment.tenantId,
          storeId: shipment.storeId,
          fulfillmentId: shipment.fulfillmentId,
        });

        const siblings = (fulfillment.shipments ?? []).filter(
          (sibling: { id: string; status: ShipmentStatus }) =>
            sibling.id !== shipment.id,
        );

        const physicallyShipped =
          siblings.some(
            (sibling: { status: ShipmentStatus }) =>
              sibling.status === ShipmentStatus.IN_TRANSIT ||
              sibling.status === ShipmentStatus.DELIVERED,
          ) ||
          fulfillment.status === FulfillmentStatus.PARTIALLY_FULFILLED ||
          fulfillment.status === FulfillmentStatus.FULFILLED;

        const otherLive = siblings.some(
          (sibling: { status: ShipmentStatus }) =>
            sibling.status !== ShipmentStatus.CANCELLED,
        );

        if (physicallyShipped) {
          // PARTIALLY SHIPPED FULFILLMENT: units have already left the
          // warehouse. Releasing the order's reservations here would
          // return already-shipped units to stock (`releaseOrder` releases
          // whole ACTIVE reservations, which cover shipped and unshipped
          // units alike), and cancelling the fulfillment would erase a
          // partially-shipped state that is still in progress. Preserve
          // the committed history; leave remainder handling to an
          // operator — flagged for reconciliation.
          await this.flagReconciliation(
            shipment,
            event,
            "Cancellation confirmed for a shipment on a partially shipped fulfillment; shipped history preserved and no inventory released",
          );

          break;
        }

        if (otherLive) {
          // Nothing has shipped yet, but sibling shipments are still
          // allocated: releasing the order would free THEIR reservations
          // too. No inventory movement; the audit record keeps the
          // decision traceable.
          await this.auditService.recordEvent({
            tenantId: event.tenantId,
            storeId: shipment.storeId,
            action: "SHIPPING_SHIPMENT_CANCELLED",
            actorType: AuditActorType.INTEGRATION,
            entityType: "SHIPMENT",
            entityId: shipment.id,
            metadata: {
              shippingEventId: event.id,
              externalEventId: event.externalEventId,
              fulfillmentId: shipment.fulfillmentId,
              reason:
                "sibling shipments still live; fulfillment kept and no inventory released",
            },
          });

          break;
        }

        // Nothing shipped anywhere and no live siblings: a full
        // cancellation is safe — the fulfillment is cancelled and the
        // order's remaining ACTIVE reservations are released (correct
        // here: every unit is still in the warehouse).
        if (
          fulfillment.status === FulfillmentStatus.READY ||
          fulfillment.status === FulfillmentStatus.IN_PROGRESS
        ) {
          await this.fulfillmentService.cancel({
            tenantId: shipment.tenantId,
            storeId: shipment.storeId,
            fulfillmentId: shipment.fulfillmentId,
          });
        }

        break;
      }

      case "record_progress": {
        // Informational progress (pickup scheduled, in-transit scans,
        // failure notices, ...): bookkeeping only, never a transition.
        await this.noteProviderArtifacts(shipment.id, wireEvent);

        break;
      }
    }
  }

  /** Cumulative SET of provider bookkeeping fields — replay-safe. */
  private async noteProviderArtifacts(
    shipmentId: string,
    wireEvent: ShippingInboundEvent,
  ): Promise<void> {
    await this.prisma.shipment.update({
      where: { id: shipmentId },
      data: {
        awbCode: wireEvent.awbCode,
        labelUrl: wireEvent.labelUrl,
        courierName: wireEvent.courierName,
        externalOrderId: wireEvent.externalOrderId,
        lastProviderStatus: wireEvent.status,
      },
    });
  }

  /**
   * Marks the shipment as needing reconciliation (verified provider
   * evidence conflicts with committed state). Never resolves anything
   * automatically.
   */
  private async flagReconciliation(
    shipment: { id: string; storeId: string },
    event: { id: string; tenantId: string; eventType: string; externalEventId: string },
    reason: string,
  ): Promise<void> {
    await this.prisma.shipment.update({
      where: { id: shipment.id },
      data: {
        needsReconciliation: true,
        reconciliationReason: reason,
      },
    });

    await this.auditService.recordEvent({
      tenantId: event.tenantId,
      storeId: shipment.storeId,
      action: "SHIPPING_RECONCILIATION_FLAGGED",
      actorType: AuditActorType.INTEGRATION,
      entityType: "SHIPMENT",
      entityId: shipment.id,
      metadata: {
        shippingEventId: event.id,
        eventType: event.eventType,
        externalEventId: event.externalEventId,
        reason,
      },
    });

    this.logger.warn(
      `Flagged shipment ${shipment.id} for reconciliation: ${reason}`,
    );
  }

  // ============================================================
  // Event row outcomes
  // ============================================================

  private async markProcessed(shippingEventId: string): Promise<void> {
    await this.prisma.shippingEvent.update({
      where: { id: shippingEventId },
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
    await this.prisma.shippingEvent.update({
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
        action: "SHIPPING_EVENT_REJECTED",
        actorType: AuditActorType.INTEGRATION,
        entityType: "SHIPPING_EVENT",
        entityId: event.id,
        metadata: {
          eventType: event.eventType,
          externalEventId: event.externalEventId,
          reason,
        },
      });
    }

    this.logger.warn(
      `Rejected shipping event ${event.id} (${event.eventType}): ${reason}`,
    );
  }

  private async finishAsIgnored(
    event: { id: string; eventType: string },
    reason: string,
  ): Promise<void> {
    await this.prisma.shippingEvent.update({
      where: { id: event.id },
      data: {
        status: WebhookStatus.PROCESSED,
        processedAt: new Date(),
        lastError: null,
        rejectionReason: reason,
      },
    });

    this.logger.warn(
      `Ignored shipping event ${event.id} (${event.eventType}): ${reason}`,
    );
  }
}

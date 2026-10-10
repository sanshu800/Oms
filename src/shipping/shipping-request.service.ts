import {
  Inject,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  AuditActorType,
  ShippingProvider,
  ShippingRequestKind,
  ShippingRequestStatus,
  ShipmentStatus,
  StoreConnectionStatus,
} from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../oms/audit/audit.service";
import { FulfillmentService } from "../oms/fulfillment/fulfillment.service";

import {
  SHIPPING_ADAPTERS,
  SHIPPING_CONTRACT_VERSION,
  ShippingCapability,
  ShippingProviderAdapter,
  shippingAdapterForProvider,
} from "./shipping-contract";

export type CreateShippingShipmentForFulfillmentInput = {
  tenantId: string;
  storeId: string;
  fulfillmentId: string;
  provider?: ShippingProvider;
};

export type CreateShippingShipmentForFulfillmentResult = {
  requestId: string;
  shipmentId: string;
  status: ShippingRequestStatus;
  externalShipmentId: string | null;
  awbCode: string | null;
  labelUrl: string | null;
};

export type RequestShippingCancellationInput = {
  tenantId: string;
  storeId: string;
  shipmentId: string;
  reason?: string;
};

export type RequestShippingCancellationResultView = {
  requestId: string;
  shipmentId: string;
  status: ShippingRequestStatus;
  providerStatus: string | null;
};

/**
 * Outbound side of the shipping boundary (TechMart → shipping provider).
 *
 * Turns a warehouse-ready fulfillment into exactly ONE provider shipment
 * request, however many times it is submitted:
 *
 * 1. The ShippingOutboundRequest row (unique on connection + idempotency
 *    key) is the local idempotency anchor — concurrent or repeated calls
 *    converge on the same row and the SAME canonical Shipment.
 * 2. The adapter call carries that same idempotency key, so a retry after
 *    a timeout/worker failure is recognized by the provider as the same
 *    request (the fake adapter enforces this; real adapters must too).
 *
 * The canonical Shipment is created HERE (from the fulfillment's items)
 * and then evolved only by verified inbound events. Nothing in this
 * service marks anything shipped: provider artifacts (AWB, label, pickup
 * schedule) are bookkeeping only.
 *
 * Cancellation: this service records a cancellation REQUEST
 * (`cancellationRequestedAt`) — the soft state. A CONFIRMED cancellation
 * is applied only from a verified inbound event through the event
 * processor, so the two states can never be conflated.
 */
@Injectable()
export class ShippingRequestService {
  private readonly logger = new Logger(ShippingRequestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fulfillmentService: FulfillmentService,
    private readonly auditService: AuditService,
    @Inject(SHIPPING_ADAPTERS)
    private readonly adapters: readonly ShippingProviderAdapter[],
  ) {}

  async createShipmentForFulfillment(
    input: CreateShippingShipmentForFulfillmentInput,
  ): Promise<CreateShippingShipmentForFulfillmentResult> {
    const provider = input.provider ?? ShippingProvider.FAKE;

    // Tenant-scoped load — FulfillmentService enforces (tenantId, storeId).
    const fulfillment = await this.fulfillmentService.getById({
      tenantId: input.tenantId,
      storeId: input.storeId,
      fulfillmentId: input.fulfillmentId,
    });

    const connection = await this.prisma.shippingConnection.findFirst({
      where: {
        tenantId: input.tenantId,
        provider,
        status: StoreConnectionStatus.ACTIVE,
      },
    });

    if (!connection) {
      throw new UnprocessableEntityException(
        `No active shipping connection for provider ${provider}`,
      );
    }

    const adapter = this.adapterFor(connection.provider);

    if (!adapter.capabilities.includes(ShippingCapability.SHIPMENT_CREATE)) {
      throw new UnprocessableEntityException(
        `Shipping adapter ${adapter.provider} does not support shipment.create`,
      );
    }

    if (fulfillment.items.length === 0) {
      throw new UnprocessableEntityException(
        `Fulfillment ${fulfillment.id} has no items to ship`,
      );
    }

    // Idempotency anchor: one provider shipment per fulfillment (v1).
    const idempotencyKey = `ship-${fulfillment.id}`;
    const existing = await this.prisma.shippingOutboundRequest.findUnique({
      where: {
        connectionId_idempotencyKey: {
          connectionId: connection.id,
          idempotencyKey,
        },
      },
    });

    if (existing && existing.status === ShippingRequestStatus.SUCCEEDED) {
      this.logger.log(
        `Shipping request ${existing.id} for fulfillment ${fulfillment.id} already ${existing.status}; not resubmitting`,
      );

      return {
        requestId: existing.id,
        shipmentId: existing.shipmentId ?? "",
        status: existing.status,
        externalShipmentId: existing.externalRequestId,
        awbCode: readResponseString(existing.responseJson, "awbCode"),
        labelUrl: readResponseString(existing.responseJson, "labelUrl"),
      };
    }

    // Resolve the canonical Shipment exactly once: adopt the anchor's
    // shipment (or the crash-orphan created for this fulfillment),
    // otherwise create it from the fulfillment's items.
    let shipmentId = existing?.shipmentId ?? null;

    if (!shipmentId) {
      const orphan = await this.prisma.shipment.findFirst({
        where: { fulfillmentId: fulfillment.id, externalShipmentId: null },
        orderBy: { createdAt: "desc" },
      });

      if (orphan) {
        shipmentId = orphan.id;
      } else {
        const shipment = await this.fulfillmentService.createShipment({
          tenantId: input.tenantId,
          storeId: input.storeId,
          fulfillmentId: fulfillment.id,
          items: fulfillment.items.map((item) => ({
            fulfillmentItemId: item.id,
            quantity: item.quantity,
          })),
        });

        shipmentId = shipment.id;
      }
    }

    const request =
      existing ??
      (await this.prisma.shippingOutboundRequest.create({
        data: {
          tenantId: input.tenantId,
          storeId: input.storeId,
          connectionId: connection.id,
          fulfillmentId: fulfillment.id,
          shipmentId,
          kind: ShippingRequestKind.SHIPMENT_CREATE,
          idempotencyKey,
          status: ShippingRequestStatus.PENDING,
        },
      }));

    if (request.shipmentId !== shipmentId) {
      await this.prisma.shippingOutboundRequest.update({
        where: { id: request.id },
        data: { shipmentId },
      });
    }

    const command = {
      contractVersion: adapter.contractVersion,
      requestId: idempotencyKey,
      fulfillmentId: fulfillment.id,
      shipmentId: shipmentId as string,
      order: {
        externalOrderNumber: fulfillment.order.orderNumber,
        orderDate: fulfillment.order.createdAt.toISOString(),
        paymentMethod: "PREPAID" as const,
      },
      deliveryAddress: {
        name: "Stage-2 Test Customer",
        address: "1 Test Street",
        city: "Testville",
        state: "TS",
        pincode: "123456",
        country: "IN",
      },
      items: fulfillment.items.map((item) => ({
        sku: item.inventoryItem.sku,
        name: item.inventoryItem.sku,
        units: item.quantity,
        sellingPrice: "0.00",
      })),
      dimensions: { length: 10, breadth: 10, height: 10, weight: 1 },
    };

    if (adapter.contractVersion !== SHIPPING_CONTRACT_VERSION) {
      throw new UnprocessableEntityException(
        `Shipping contract version mismatch: core speaks ${SHIPPING_CONTRACT_VERSION}, adapter speaks ${adapter.contractVersion}`,
      );
    }

    let result;

    try {
      result = await adapter.createShipment(command);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      await this.prisma.shippingOutboundRequest.update({
        where: { id: request.id },
        data: {
          status: ShippingRequestStatus.FAILED,
          failedAt: new Date(),
          lastError: message,
        },
      });

      await this.auditService.recordEvent({
        tenantId: input.tenantId,
        storeId: input.storeId,
        action: "SHIPPING_SHIPMENT_REQUEST_FAILED",
        actorType: AuditActorType.INTEGRATION,
        entityType: "SHIPPING_OUTBOUND_REQUEST",
        entityId: request.id,
        metadata: {
          fulfillmentId: fulfillment.id,
          connectionId: connection.id,
          idempotencyKey,
          error: message,
        },
      });

      throw error;
    }

    // Bookkeeping only: the provider's creation artifacts. This NEVER
    // changes the Shipment's status — only verified inbound handover
    // evidence does (see ShippingEventProcessorService).
    await this.prisma.shipment.update({
      where: { id: shipmentId as string },
      data: {
        externalShipmentId: result.externalShipmentId,
        externalOrderId: result.externalOrderId,
        awbCode: result.awbCode,
        labelUrl: result.labelUrl,
        courierName: result.courierName,
        carrier: result.courierName,
        trackingNumber: result.awbCode,
        trackingUrl: result.labelUrl,
        lastProviderStatus: "awb_assigned",
      },
    });

    const responseJson = {
      externalShipmentId: result.externalShipmentId,
      externalOrderId: result.externalOrderId,
      awbCode: result.awbCode,
      labelUrl: result.labelUrl,
      courierName: result.courierName,
    };

    const submitted = await this.prisma.shippingOutboundRequest.update({
      where: { id: request.id },
      data: {
        status: ShippingRequestStatus.SUCCEEDED,
        externalRequestId: result.externalShipmentId,
        responseJson,
        succeededAt: new Date(),
        lastError: null,
        failedAt: null,
      },
    });

    await this.auditService.recordEvent({
      tenantId: input.tenantId,
      storeId: input.storeId,
      action: "SHIPPING_SHIPMENT_REQUEST_SUCCEEDED",
      actorType: AuditActorType.INTEGRATION,
      entityType: "SHIPPING_OUTBOUND_REQUEST",
      entityId: request.id,
      metadata: {
        fulfillmentId: fulfillment.id,
        connectionId: connection.id,
        idempotencyKey,
        externalShipmentId: result.externalShipmentId,
        awbCode: result.awbCode,
      },
    });

    this.logger.log(
      `Submitted shipping request ${request.id} (${result.externalShipmentId}) for fulfillment ${fulfillment.id}`,
    );

    return {
      requestId: submitted.id,
      shipmentId: shipmentId as string,
      status: submitted.status,
      externalShipmentId: submitted.externalRequestId,
      awbCode: result.awbCode ?? null,
      labelUrl: result.labelUrl ?? null,
    };
  }

  /**
   * Records a cancellation REQUEST at the provider — the soft state.
   * `cancellationRequestedAt` bookkeeping is set; the Shipment's status is
   * NEVER changed here. A confirmed cancellation arrives as a verified
   * inbound event (`shipping.cancellation.confirmed`) and is applied by
   * the event processor.
   */
  async requestCancellation(
    input: RequestShippingCancellationInput,
  ): Promise<RequestShippingCancellationResultView> {
    const shipment = await this.prisma.shipment.findFirst({
      where: {
        id: input.shipmentId,
        tenantId: input.tenantId,
        storeId: input.storeId,
      },
    });

    if (!shipment) {
      throw new UnprocessableEntityException(
        `Shipment not found: ${input.shipmentId}`,
      );
    }

    if (shipment.status === ShipmentStatus.CANCELLED) {
      // Already CONFIRMED cancelled — a request would be meaningless.
      throw new UnprocessableEntityException(
        `Shipment ${shipment.id} is already cancelled`,
      );
    }

    if (
      shipment.status === ShipmentStatus.IN_TRANSIT ||
      shipment.status === ShipmentStatus.DELIVERED
    ) {
      // Matches provider semantics (cancel only before dispatch).
      throw new UnprocessableEntityException(
        `Cannot request cancellation for shipment ${shipment.id} from status ${shipment.status}`,
      );
    }

    const connection = await this.prisma.shippingConnection.findFirst({
      where: {
        tenantId: input.tenantId,
        status: StoreConnectionStatus.ACTIVE,
      },
    });

    if (!connection) {
      throw new UnprocessableEntityException(
        "No active shipping connection",
      );
    }

    const adapter = this.adapterFor(connection.provider);

    if (!adapter.capabilities.includes(ShippingCapability.SHIPMENT_CANCEL)) {
      throw new UnprocessableEntityException(
        `Shipping adapter ${adapter.provider} does not support shipment.cancel`,
      );
    }

    const idempotencyKey = `cancel-${shipment.id}`;
    const existing = await this.prisma.shippingOutboundRequest.findUnique({
      where: {
        connectionId_idempotencyKey: {
          connectionId: connection.id,
          idempotencyKey,
        },
      },
    });

    if (existing && existing.status === ShippingRequestStatus.SUCCEEDED) {
      return {
        requestId: existing.id,
        shipmentId: shipment.id,
        status: existing.status,
        providerStatus: readResponseString(existing.responseJson, "status"),
      };
    }

    const request =
      existing ??
      (await this.prisma.shippingOutboundRequest.create({
        data: {
          tenantId: input.tenantId,
          storeId: input.storeId,
          connectionId: connection.id,
          fulfillmentId: shipment.fulfillmentId,
          shipmentId: shipment.id,
          kind: ShippingRequestKind.SHIPMENT_CANCEL,
          idempotencyKey,
          status: ShippingRequestStatus.PENDING,
        },
      }));

    let result;

    try {
      result = await adapter.requestCancellation({
        requestId: idempotencyKey,
        externalShipmentId: shipment.externalShipmentId ?? "",
        awbCode: shipment.awbCode ?? undefined,
        reason: input.reason,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      await this.prisma.shippingOutboundRequest.update({
        where: { id: request.id },
        data: {
          status: ShippingRequestStatus.FAILED,
          failedAt: new Date(),
          lastError: message,
        },
      });

      await this.auditService.recordEvent({
        tenantId: input.tenantId,
        storeId: input.storeId,
        action: "SHIPPING_CANCELLATION_REQUEST_FAILED",
        actorType: AuditActorType.INTEGRATION,
        entityType: "SHIPPING_OUTBOUND_REQUEST",
        entityId: request.id,
        metadata: {
          shipmentId: shipment.id,
          connectionId: connection.id,
          idempotencyKey,
          error: message,
        },
      });

      throw error;
    }

    // Soft state bookkeeping ONLY. Even a synchronous "confirmed" reply is
    // recorded as provider status text; the CONFIRMED transition itself is
    // applied only from verified inbound evidence (single write path).
    await this.prisma.shipment.update({
      where: { id: shipment.id },
      data: {
        cancellationRequestedAt: shipment.cancellationRequestedAt ?? new Date(),
        cancellationRequestRef: idempotencyKey,
        lastProviderStatus:
          result.status === "cancelled" ? "cancelled" : "cancellation_requested",
      },
    });

    const responseJson = { status: result.status, requestId: idempotencyKey };

    const submitted = await this.prisma.shippingOutboundRequest.update({
      where: { id: request.id },
      data: {
        status: ShippingRequestStatus.SUCCEEDED,
        responseJson,
        succeededAt: new Date(),
        lastError: null,
        failedAt: null,
      },
    });

    await this.auditService.recordEvent({
      tenantId: input.tenantId,
      storeId: input.storeId,
      action: "SHIPPING_CANCELLATION_REQUESTED",
      actorType: AuditActorType.INTEGRATION,
      entityType: "SHIPPING_OUTBOUND_REQUEST",
      entityId: request.id,
      metadata: {
        shipmentId: shipment.id,
        connectionId: connection.id,
        idempotencyKey,
        providerStatus: result.status,
      },
    });

    return {
      requestId: submitted.id,
      shipmentId: shipment.id,
      status: submitted.status,
      providerStatus: result.status,
    };
  }

  private adapterFor(provider: ShippingProvider): ShippingProviderAdapter {
    return shippingAdapterForProvider(this.adapters, provider);
  }
}

function readResponseString(
  responseJson: unknown,
  key: string,
): string | null {
  if (
    responseJson &&
    typeof responseJson === "object" &&
    !Array.isArray(responseJson)
  ) {
    const value = (responseJson as Record<string, unknown>)[key];

    if (typeof value === "string") {
      return value;
    }
  }

  return null;
}

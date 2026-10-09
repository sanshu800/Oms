import {
  Inject,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  AuditActorType,
  StoreConnectionStatus,
  WmsProvider,
  WmsRequestStatus,
} from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../oms/audit/audit.service";
import { FulfillmentService } from "../oms/fulfillment/fulfillment.service";

import {
  WMS_ADAPTERS,
  WMS_CONTRACT_VERSION,
  WmsAdapter,
  WmsSubmitFulfillmentRequestCommand,
  wmsAdapterForProvider,
} from "./wms-contract";

/**
 * Outbound side of the WMS boundary (TechMart → WMS).
 *
 * Turns a reserved order's fulfillment into exactly ONE warehouse
 * request, however many times it is submitted:
 *
 * 1. The WmsFulfillmentRequest row (unique on connection + idempotency
 *    key = fulfillment id) is the local idempotency anchor — concurrent
 *    or repeated calls converge on the same row.
 * 2. The adapter call carries that same idempotency key, so a retry after
 *    a timeout/worker failure is recognized by the warehouse as the same
 *    request (the fake adapter enforces this; real adapters must too).
 *
 * Nothing here invents provider capabilities: the adapter's declared
 * `capabilities` and pinned `contractVersion` are checked before submit.
 */
@Injectable()
export class WmsRequestService {
  private readonly logger = new Logger(WmsRequestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fulfillmentService: FulfillmentService,
    private readonly auditService: AuditService,
    @Inject(WMS_ADAPTERS)
    private readonly adapters: readonly WmsAdapter[],
  ) {}

  async submitFulfillmentRequest(input: {
    tenantId: string;
    storeId: string;
    fulfillmentId: string;
  }): Promise<{
    requestId: string;
    status: WmsRequestStatus;
    externalRequestId: string | null;
  }> {
    // Tenant-scoped load — FulfillmentService enforces (tenantId, storeId).
    const fulfillment = await this.fulfillmentService.getById({
      tenantId: input.tenantId,
      storeId: input.storeId,
      fulfillmentId: input.fulfillmentId,
    });

    const connection = await this.prisma.wmsConnection.findFirst({
      where: {
        tenantId: input.tenantId,
        locationId: fulfillment.locationId,
        status: StoreConnectionStatus.ACTIVE,
      },
    });

    if (!connection) {
      throw new UnprocessableEntityException(
        `No active WMS connection for location ${fulfillment.locationId}`,
      );
    }

    const adapter = this.adapterFor(connection.provider);

    if (!adapter.capabilities.includes("fulfillment.submit")) {
      throw new UnprocessableEntityException(
        `WMS adapter ${adapter.provider} does not support fulfillment.submit`,
      );
    }

    // Idempotency anchor: one request per (connection, fulfillment).
    const idempotencyKey = fulfillment.id;
    const existing = await this.prisma.wmsFulfillmentRequest.findUnique({
      where: {
        connectionId_idempotencyKey: {
          connectionId: connection.id,
          idempotencyKey,
        },
      },
    });

    if (
      existing &&
      existing.status !== WmsRequestStatus.PENDING &&
      existing.status !== WmsRequestStatus.FAILED
    ) {
      this.logger.log(
        `WMS request ${existing.id} for fulfillment ${fulfillment.id} already ${existing.status}; not resubmitting`,
      );

      return {
        requestId: existing.id,
        status: existing.status,
        externalRequestId: existing.externalRequestId,
      };
    }

    if (fulfillment.items.length === 0) {
      throw new UnprocessableEntityException(
        `Fulfillment ${fulfillment.id} has no items to submit`,
      );
    }

    // Create the anchor row first (PENDING), then call the adapter. A
    // crash between the two leaves a PENDING row that the next submit
    // retries with the SAME idempotency key.
    const request =
      existing ??
      (await this.prisma.wmsFulfillmentRequest.create({
        data: {
          tenantId: input.tenantId,
          storeId: input.storeId,
          connectionId: connection.id,
          fulfillmentId: fulfillment.id,
          idempotencyKey,
          status: WmsRequestStatus.PENDING,
          lines: {
            create: fulfillment.items.map((item) => ({
              orderItemId: item.orderItemId,
              externalLineRef: item.orderItemId,
              sku: item.inventoryItem.sku,
              quantity: item.quantity,
            })),
          },
        },
      }));

    const command: WmsSubmitFulfillmentRequestCommand = {
      contractVersion: adapter.contractVersion,
      idempotencyKey,
      externalWarehouseId: connection.externalWarehouseId,
      request: {
        requestRef: idempotencyKey,
        orderReference: fulfillment.order.orderNumber,
        requestedAt: new Date().toISOString(),
        lines: fulfillment.items.map((item) => ({
          externalLineRef: item.orderItemId,
          sku: item.inventoryItem.sku,
          quantity: item.quantity,
        })),
      },
    };

    if (command.contractVersion !== WMS_CONTRACT_VERSION) {
      throw new UnprocessableEntityException(
        `WMS contract version mismatch: core speaks ${WMS_CONTRACT_VERSION}, adapter speaks ${adapter.contractVersion}`,
      );
    }

    let result;

    try {
      result = await adapter.submitFulfillmentRequest(command);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      await this.prisma.wmsFulfillmentRequest.update({
        where: { id: request.id },
        data: {
          status: WmsRequestStatus.FAILED,
          failedAt: new Date(),
          lastError: message,
        },
      });

      await this.auditService.recordEvent({
        tenantId: input.tenantId,
        storeId: input.storeId,
        action: "WMS_FULFILLMENT_REQUEST_FAILED",
        actorType: AuditActorType.INTEGRATION,
        entityType: "WMS_FULFILLMENT_REQUEST",
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

    const submitted = await this.prisma.wmsFulfillmentRequest.update({
      where: { id: request.id },
      data: {
        status: WmsRequestStatus.SUBMITTED,
        externalRequestId: result.externalRequestId,
        submittedAt: new Date(),
        lastError: null,
        failedAt: null,
      },
    });

    await this.auditService.recordEvent({
      tenantId: input.tenantId,
      storeId: input.storeId,
      action: "WMS_FULFILLMENT_REQUEST_SUBMITTED",
      actorType: AuditActorType.INTEGRATION,
      entityType: "WMS_FULFILLMENT_REQUEST",
      entityId: request.id,
      metadata: {
        fulfillmentId: fulfillment.id,
        connectionId: connection.id,
        idempotencyKey,
        externalRequestId: result.externalRequestId,
      },
    });

    this.logger.log(
      `Submitted WMS request ${request.id} (${result.externalRequestId}) for fulfillment ${fulfillment.id}`,
    );

    return {
      requestId: submitted.id,
      status: submitted.status,
      externalRequestId: submitted.externalRequestId,
    };
  }

  private adapterFor(provider: WmsProvider): WmsAdapter {
    return wmsAdapterForProvider(this.adapters, provider);
  }
}

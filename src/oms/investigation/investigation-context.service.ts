import { Injectable, NotFoundException } from "@nestjs/common";
import {
  InventoryReservationStatus,
  Prisma,
} from "@prisma/client";

import { PrismaService } from "../../prisma/prisma.service";
import { ExceptionService } from "../exception/exception.service";
import { InventoryTruthService } from "../inventory/inventory-truth.service";

export type InvestigationContext = {
  exception: {
    id: string;
    category: string;
    severity: string;
    status: string;
    title: string;
    fingerprint: string;
    detectedAt: Date;
    updatedAt: Date;
    recommendedNextStep: string;
    evidence: Prisma.JsonValue;
  };

  order: {
    id: string;
    orderNumber: string;
    status: string;
    paymentStatus: string;
    fulfillmentStatus: string;
    currency: string;
    totalAmount: string;
    orderedAt: Date;
  } | null;

  affectedItem: {
    id: string;
    sku: string;
    title: string;
    quantity: number;
    inventoryItemId: string | null;
  } | null;

  inventory: {
    inventoryItemId: string;
    sku: string;
    name: string;
    availableQty: number;
    reservedQty: number;
    committedQty: number;
    onHandQty: number;
    locationCount: number;
    isStale: boolean;
    locations: Array<{
      locationId: string;
      locationCode: string;
      locationName: string;
      availableQty: number;
      reservedQty: number;
      committedQty: number;
      onHandQty: number;
      updatedAt: Date;
      isStale: boolean;
    }>;
  } | null;

  reservations: Array<{
    id: string;
    locationId: string;
    quantity: number;
    status: InventoryReservationStatus;
  }>;
};

@Injectable()
export class InvestigationContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly exceptionService: ExceptionService,
    private readonly inventoryTruthService: InventoryTruthService,
  ) {}

  async getContext(input: {
    tenantId: string;
    storeId: string;
    exceptionId: string;
  }): Promise<InvestigationContext> {
    const exception = await this.exceptionService.getById({
      tenantId: input.tenantId,
      storeId: input.storeId,
      exceptionId: input.exceptionId,
    });

    if (!exception) {
      throw new NotFoundException(
        `Operational exception not found: ${input.exceptionId}`,
      );
    }

    const evidence =
      exception.evidence &&
      typeof exception.evidence === "object" &&
      !Array.isArray(exception.evidence)
        ? (exception.evidence as Record<string, unknown>)
        : {};

    const orderId =
      typeof evidence.orderId === "string"
        ? evidence.orderId
        : null;

    const orderItemId =
      typeof evidence.orderItemId === "string"
        ? evidence.orderItemId
        : null;

    const sku =
      typeof evidence.sku === "string"
        ? evidence.sku.trim()
        : null;

    const [order, inventory] = await Promise.all([
      orderId
        ? this.prisma.order.findFirst({
            where: {
              id: orderId,
              tenantId: input.tenantId,
              storeId: input.storeId,
            },
            include: {
              items: true,
            },
          })
        : null,

      sku
        ? this.inventoryTruthService
            .getSkuTruth({ tenantId: input.tenantId, sku })
            // getSkuTruth deliberately throws on a genuinely invalid
            // on-hand balance (negative stock) rather than silently
            // reporting a wrong number — but that is exactly the
            // exception category a human most needs to inspect, so
            // this view must still render; it just can't show a
            // trustworthy inventory snapshot for that SKU right now.
            .catch(() => null)
        : null,
    ]);

    const affectedItem =
      order && orderItemId
        ? order.items.find((item) => item.id === orderItemId) ?? null
        : order && sku
          ? order.items.find((item) => item.sku === sku) ?? null
          : null;

    const reservations =
      orderId
        ? await this.prisma.inventoryReservation.findMany({
            where: {
              tenantId: input.tenantId,
              storeId: input.storeId,
              orderId,
              ...(orderItemId ? { orderItemId } : {}),
            },
            select: {
              id: true,
              locationId: true,
              quantity: true,
              status: true,
            },
            orderBy: {
              createdAt: "desc",
            },
          })
        : [];

    return {
      exception: {
        id: exception.id,
        category: exception.category,
        severity: exception.severity,
        status: exception.status,
        title: exception.title,
        fingerprint: exception.fingerprint,
        detectedAt: exception.detectedAt,
        updatedAt: exception.updatedAt,
        recommendedNextStep: exception.recommendedNextStep,
        evidence: exception.evidence,
      },

      order: order
        ? {
            id: order.id,
            orderNumber: order.orderNumber,
            status: order.status,
            paymentStatus: order.paymentStatus,
            fulfillmentStatus: order.fulfillmentStatus,
            currency: order.currency,
            totalAmount: order.totalAmount.toString(),
            orderedAt: order.orderedAt,
          }
        : null,

      affectedItem: affectedItem
        ? {
            id: affectedItem.id,
            sku: affectedItem.sku,
            title: affectedItem.title,
            quantity: affectedItem.quantity,
            inventoryItemId: affectedItem.inventoryItemId,
          }
        : null,

      inventory,

      reservations,
    };
  }
}


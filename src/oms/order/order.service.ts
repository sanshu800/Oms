import { Injectable } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';

import {
  NormalizedOrder,
  NormalizedOrderLine,
} from '../../connectors/connector.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { OrderFailureExceptionService } from './order-failure-exception.service';
import { OrderBusinessFailureError } from './order-business-failure.error';
import { assertOrderTransition } from './order-lifecycle';

/** Line shape used internally after decimal conversion. */
type OrderLineDraft = {
  externalLineItemId: string;
  externalItemRef: string | null;
  sku: string;
  title: string;
  quantity: number;
  unitPrice?: Prisma.Decimal;
};

@Injectable()
export class OrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventoryService: InventoryService,
    private readonly orderFailureExceptionService: OrderFailureExceptionService,
  ) {}

  /**
   * The only way channel order events enter canonical order logic
   * (locked decision 2): the channel connector has already parsed and
   * validated the payload into a NormalizedOrder (decision 3 — this
   * service contains zero channel payload parsing).
   */
  async upsertFromChannel(input: {
    tenantId: string;
    storeId: string;
    order: NormalizedOrder;
  }) {
    const normalized = input.order;

    const externalOrderId = normalized.externalOrderId;
    const orderNumber = normalized.orderNumber;
    const isCancelled = normalized.cancelled;
    const paymentStatus = normalized.paymentStatus;
    const fulfillmentStatus = normalized.fulfillmentStatus;
    const totalPrice = normalized.totalAmount;
    const currency = normalized.currency;
    const orderedAt = normalized.orderedAt;
    const lineItems: OrderLineDraft[] | undefined = normalized.lines?.map(
      (line: NormalizedOrderLine) => ({
        externalLineItemId: line.externalLineItemId,
        externalItemRef: line.externalItemRef,
        sku: line.sku,
        title: line.title,
        quantity: line.quantity,
        unitPrice:
          line.unitPrice !== null
            ? new Prisma.Decimal(line.unitPrice)
            : undefined,
      }),
    );

    const existing = await this.prisma.order.findUnique({
      where: {
        storeId_externalOrderId: {
          storeId: input.storeId,
          externalOrderId,
        },
      },
      include: {
        items: true,
        reservations: {
          select: {
            orderItemId: true,
            quantity: true,
            status: true,
          },
        },
      },
    });

    if (existing) {
      // The channel may deliver an older update after the cancellation
      // event. Preserve the complete terminal OMS snapshot, not just its
      // status.
      if (existing.status === OrderStatus.CANCELLED && !isCancelled) {
        return this.prisma.order.findUniqueOrThrow({
          where: { id: existing.id },
          include: { items: true },
        });
      }

      await this.prisma.order.update({
        where: { id: existing.id },
        data: {
          orderNumber,
          paymentStatus,
          fulfillmentStatus,
          totalAmount: new Prisma.Decimal(totalPrice),
          currency,
          orderedAt,
        },
      });

      if (isCancelled) {
        await this.inventoryService.releaseOrder({
          tenantId: input.tenantId,
          storeId: input.storeId,
          orderId: existing.id,
        });
        await this.prisma.order.update({
          where: { id: existing.id },
          data: { status: OrderStatus.CANCELLED },
        });

        return this.prisma.order.findUniqueOrThrow({
          where: { id: existing.id },
          include: { items: true },
        });
      }

      const hasCommittedInventory =
        existing.status === OrderStatus.FULFILLING ||
        existing.status === OrderStatus.FULFILLED ||
        existing.reservations.some(
          (reservation) =>
            reservation.status === "COMMITTED" ||
            reservation.status === "SHIPPED",
        );
      let shouldReserve = false;

      if (lineItems) {
        const inventoryChanged = this.haveInventoryLinesChanged(
          existing.items,
          lineItems,
        );

        if (inventoryChanged && !hasCommittedInventory) {
          // Release first, then reconcile and reserve the current channel
          // snapshot. This makes quantity reductions/removals free stock.
          await this.inventoryService.releaseOrder({
            tenantId: input.tenantId,
            storeId: input.storeId,
            orderId: existing.id,
          });
          await this.syncLineItems(existing.id, existing.items, lineItems, true);
          shouldReserve = true;
        } else {
          // Never rewrite SKU/quantity after a reservation has been committed
          // to fulfillment. The channel may still update descriptions or prices.
          await this.syncLineItems(
            existing.id,
            existing.items,
            lineItems,
            !hasCommittedInventory,
          );
        }
      }

      // If an earlier allocation attempt failed transiently, retry when the
      // persisted order still has unreserved quantity, even if the channel
      // sends the same line-item snapshot on its retry/update event.
      if (
        !shouldReserve &&
        !hasCommittedInventory &&
        this.hasUnreservedQuantity(existing.items, existing.reservations)
      ) {
        shouldReserve = true;
      }

      if (shouldReserve) {
        const orderForReservation = await this.prisma.order.findUniqueOrThrow({
          where: { id: existing.id },
          include: { items: true },
        });
        await this.reserveOrderOrRaiseFailure({
          tenantId: input.tenantId,
          storeId: input.storeId,
          order: orderForReservation,
        });
      }

      return this.prisma.order.findUniqueOrThrow({
        where: { id: existing.id },
        include: { items: true },
      });
    }

    const order = await this.prisma.order.create({
      data: {
        tenantId: input.tenantId,
        storeId: input.storeId,
        externalOrderId,
        orderNumber,
        status: isCancelled ? OrderStatus.CANCELLED : OrderStatus.NEW,
        paymentStatus,
        fulfillmentStatus,
        totalAmount: new Prisma.Decimal(totalPrice),
        currency,
        orderedAt,
        items: {
          create: lineItems ?? [],
        },
      },
      include: { items: true },
    });

    if (isCancelled) {
      return order;
    }

    await this.reserveOrderOrRaiseFailure({
      tenantId: input.tenantId,
      storeId: input.storeId,
      order,
    });

    return this.prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    });
  }

  async transitionStatus(input: {
    tenantId: string;
    storeId: string;
    orderId: string;
    to: OrderStatus;
  }) {
    const order = await this.prisma.order.findFirst({
      where: {
        id: input.orderId,
        tenantId: input.tenantId,
        storeId: input.storeId,
      },
      select: {
        id: true,
        status: true,
      },
    });

    if (!order) {
      throw new Error('Order not found');
    }

    assertOrderTransition(order.status, input.to);

    const updated = await this.prisma.order.updateMany({
      where: {
        id: order.id,
        tenantId: input.tenantId,
        storeId: input.storeId,
        status: order.status,
      },
      data: {
        status: input.to,
      },
    });

    if (updated.count !== 1) {
      throw new Error(
        'Order status changed before transition could be applied',
      );
    }

    try {
      if (input.to === OrderStatus.CANCELLED) {
        await this.inventoryService.releaseOrder({
          tenantId: input.tenantId,
          storeId: input.storeId,
          orderId: order.id,
        });
      }

      if (input.to === OrderStatus.FULFILLING) {
        await this.inventoryService.commitOrder({
          tenantId: input.tenantId,
          storeId: input.storeId,
          orderId: order.id,
        });
      }

      if (input.to === OrderStatus.FULFILLED) {
        await this.inventoryService.shipOrder({
          tenantId: input.tenantId,
          storeId: input.storeId,
          orderId: order.id,
        });
      }
    } catch (error) {
      await this.prisma.order.update({
        where: {
          id: order.id,
        },
        data: {
          status: OrderStatus.FAILED,
        },
      });

      throw error;
    }

    return this.prisma.order.findUniqueOrThrow({
      where: {
        id: order.id,
      },
      include: {
        items: true,
        reservations: true,
      },
    });
  }

  private async reserveOrderOrRaiseFailure(input: {
    tenantId: string;
    storeId: string;
    order: {
      id: string;
      orderNumber: string;
      items: Array<{
        id: string;
        sku: string;
        quantity: number;
      }>;
    };
  }): Promise<void> {
    try {
      await this.inventoryService.reserveOrder({
        tenantId: input.tenantId,
        storeId: input.storeId,
        orderId: input.order.id,
      });
    } catch (error) {
      await this.prisma.order.update({
        where: { id: input.order.id },
        data: { status: OrderStatus.FAILED },
      });

      for (const failedItem of input.order.items) {
        if (failedItem.quantity <= 0) continue;

        const failure = await this.orderFailureExceptionService.detectAndRaise({
          tenantId: input.tenantId,
          storeId: input.storeId,
          orderId: input.order.id,
          orderNumber: input.order.orderNumber,
          orderItemId: failedItem.id,
          sku: failedItem.sku,
          requestedQty: failedItem.quantity,
        });

        if (!failure.detection.detected) continue;
        if (!failure.exception?.id) {
          throw new Error(
            "Detected order business failure did not return an operational exception ID",
          );
        }

        throw new OrderBusinessFailureError(
          error instanceof Error ? error.message : String(error),
          failure.exception.id,
          input.order.id,
        );
      }

      throw error;
    }
  }

  private hasUnreservedQuantity(
    items: Array<{ id: string; quantity: number }>,
    reservations: Array<{
      orderItemId: string;
      quantity: number;
      status: string;
    }>,
  ): boolean {
    const coveredByItem = new Map<string, number>();
    for (const reservation of reservations) {
      if (
        reservation.status !== "ACTIVE" &&
        reservation.status !== "COMMITTED" &&
        reservation.status !== "SHIPPED"
      ) {
        continue;
      }
      coveredByItem.set(
        reservation.orderItemId,
        (coveredByItem.get(reservation.orderItemId) ?? 0) +
          reservation.quantity,
      );
    }

    return items.some(
      (item) =>
        item.quantity > (coveredByItem.get(item.id) ?? 0),
    );
  }

  private haveInventoryLinesChanged(
    existingItems: Array<{
      externalLineItemId: string;
      sku: string;
      quantity: number;
    }>,
    desiredItems: Array<{
      externalLineItemId: string;
      sku: string;
      quantity: number;
    }>,
  ): boolean {
    const activeExistingItems = existingItems.filter(
      (item) => item.quantity > 0,
    );
    if (activeExistingItems.length !== desiredItems.length) return true;

    const existingByExternalId = new Map(
      activeExistingItems.map((item) => [item.externalLineItemId, item]),
    );

    return desiredItems.some((desired) => {
      const existing = existingByExternalId.get(desired.externalLineItemId);
      return (
        !existing ||
        existing.sku !== desired.sku ||
        existing.quantity !== desired.quantity
      );
    });
  }

  private async syncLineItems(
    orderId: string,
    existingItems: Array<{
      id: string;
      externalLineItemId: string;
      sku: string;
      quantity: number;
    }>,
    desiredItems: OrderLineDraft[],
    includeInventoryFields: boolean,
  ): Promise<void> {
    const existingByExternalId = new Map(
      existingItems.map((item) => [item.externalLineItemId, item]),
    );
    const desiredExternalIds = new Set(
      desiredItems.map((item) => item.externalLineItemId),
    );

    for (const item of desiredItems) {
      const existing = existingByExternalId.get(item.externalLineItemId);
      if (!existing) {
        if (!includeInventoryFields) continue;

        await this.prisma.orderItem.create({
          data: {
            orderId,
            externalLineItemId: item.externalLineItemId,
            externalItemRef: item.externalItemRef,
            sku: item.sku,
            title: item.title,
            quantity: item.quantity,
            ...(item.unitPrice ? { unitPrice: item.unitPrice } : {}),
          },
        });
        continue;
      }

      await this.prisma.orderItem.update({
        where: { id: existing.id },
        data: {
          title: item.title,
          ...(item.unitPrice ? { unitPrice: item.unitPrice } : {}),
          ...(includeInventoryFields
            ? {
                sku: item.sku,
                ...(item.externalItemRef
                  ? { externalItemRef: item.externalItemRef }
                  : {}),
                quantity: item.quantity,
                ...(existing.sku !== item.sku
                  ? { inventoryItemId: null }
                  : {}),
              }
            : {}),
        },
      });
    }

    if (!includeInventoryFields) return;

    for (const existing of existingItems) {
      if (
        existing.quantity > 0 &&
        !desiredExternalIds.has(existing.externalLineItemId)
      ) {
        // Keep the row for audit/history rather than cascading away released
        // reservations. Zero-quantity rows are ignored by allocation.
        await this.prisma.orderItem.update({
          where: { id: existing.id },
          data: {
            quantity: 0,
            inventoryItemId: null,
          },
        });
      }
    }
  }

}

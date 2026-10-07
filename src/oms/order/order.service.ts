import { Injectable } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { OrderFailureExceptionService } from './order-failure-exception.service';
import { OrderBusinessFailureError } from './order-business-failure.error';
import { assertOrderTransition } from './order-lifecycle';

@Injectable()
export class OrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventoryService: InventoryService,
    private readonly orderFailureExceptionService: OrderFailureExceptionService,
  ) {}

  async upsertFromShopify(input: {
    tenantId: string;
    storeId: string;
    payload: unknown;
    topic?: "orders/create" | "orders/updated" | "orders/cancelled";
  }) {
    const payload = this.requireShopifyObject(input.payload);
    const topic = input.topic ?? "orders/create";
    const isCancelled = topic === "orders/cancelled" || Boolean(payload.cancelled_at);

    const externalOrderId = this.requireShopifyString(
      payload.id,
      "order.id",
    );
    const orderNumber = this.requireShopifyString(
      payload.name,
      "order.name",
    );
    const paymentStatus = this.requireShopifyString(
      payload.financial_status,
      "order.financial_status",
    );
    const fulfillmentStatus =
      typeof payload.fulfillment_status === "string"
        ? payload.fulfillment_status
        : "unfulfilled";
    const totalPrice = this.requireShopifyString(
      payload.total_price,
      "order.total_price",
    );
    const currency = this.requireShopifyString(
      payload.currency,
      "order.currency",
    );
    const orderedAt = this.requireShopifyDate(
      payload.created_at,
      "order.created_at",
    );
    const lineItems = Array.isArray(payload.line_items)
      ? this.parseLineItems(payload.line_items)
      : undefined;

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
      // Shopify may deliver an older update after the cancellation event.
      // Preserve the complete terminal OMS snapshot, not just its status.
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
          // Release first, then reconcile and reserve the current Shopify
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
          // to fulfillment. Shopify may still update descriptions or prices.
          await this.syncLineItems(
            existing.id,
            existing.items,
            lineItems,
            !hasCommittedInventory,
          );
        }
      }

      // If an earlier allocation attempt failed transiently, retry when the
      // persisted order still has unreserved quantity, even if Shopify sends
      // the same line-item snapshot on its retry/update event.
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
    desiredItems: Array<{
      externalLineItemId: string;
      sku: string;
      title: string;
      quantity: number;
      unitPrice?: Prisma.Decimal;
    }>,
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

  private requireShopifyObject(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Shopify order payload must be an object");
    }

    return value as Record<string, unknown>;
  }

  private parseLineItems(value: unknown): Array<{
    externalLineItemId: string;
    sku: string;
    title: string;
    quantity: number;
    unitPrice?: Prisma.Decimal;
  }> {
    if (!Array.isArray(value)) {
      return [];
    }

    const externalLineItemIds = new Set<string>();
    return value.map((rawItem, index) => {
      const item = rawItem as Record<string, unknown>;

      const externalLineItemId = this.requireShopifyString(
        item.id,
        `order.line_items[${index}].id`,
      );
      if (externalLineItemIds.has(externalLineItemId)) {
        throw new Error(
          `Duplicate Shopify line item ID: ${externalLineItemId}`,
        );
      }
      externalLineItemIds.add(externalLineItemId);

      const sku =
        typeof item.sku === 'string' &&
        item.sku.trim() !== ''
          ? item.sku.trim()
          : this.requireShopifyString(
              item.variant_id,
              `order.line_items[${index}].variant_id`,
            );

      const title =
        typeof item.title === 'string' &&
        item.title.trim() !== ''
          ? item.title.trim()
          : sku;

      const quantity = Number(item.quantity);

      if (!Number.isInteger(quantity) || quantity <= 0) {
        throw new Error(
          `Invalid quantity for order.line_items[${index}]`,
        );
      }

      const price =
        typeof item.price === 'string' ||
        typeof item.price === 'number'
          ? new Prisma.Decimal(String(item.price))
          : undefined;

      return {
        externalLineItemId,
        sku,
        title,
        quantity,
        unitPrice: price,
      };
    });
  }

  private requireShopifyString(
    value: unknown,
    field: string,
  ): string {
    if (
      (typeof value !== 'string' &&
        typeof value !== 'number') ||
      String(value).trim() === ''
    ) {
      throw new Error(
        `Missing required Shopify field: ${field}`,
      );
    }

    return String(value);
  }

  private requireShopifyDate(
    value: unknown,
    field: string,
  ): Date {
    if (
      typeof value !== 'string' ||
      value.trim() === ''
    ) {
      throw new Error(
        `Missing required Shopify field: ${field}`,
      );
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      throw new Error(
        `Invalid Shopify date: ${field}`,
      );
    }

    return date;
  }
}







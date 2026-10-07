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
  }) {
    const payload = input.payload as Record<string, unknown>;

    const externalOrderId = this.requireShopifyString(
      payload.id,
      'order.id',
    );

    const orderNumber = this.requireShopifyString(
      payload.name,
      'order.name',
    );

    const paymentStatus = this.requireShopifyString(
      payload.financial_status,
      'order.financial_status',
    );

    const fulfillmentStatus =
      typeof payload.fulfillment_status === 'string'
        ? payload.fulfillment_status
        : 'unfulfilled';

    const totalPrice = this.requireShopifyString(
      payload.total_price,
      'order.total_price',
    );

    const currency = this.requireShopifyString(
      payload.currency,
      'order.currency',
    );

    const orderedAt = this.requireShopifyDate(
      payload.created_at,
      'order.created_at',
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
      },
    });

    if (existing) {
      return this.prisma.order.update({
        where: {
          id: existing.id,
        },
        data: {
          orderNumber,
          paymentStatus,
          fulfillmentStatus,
          totalAmount: new Prisma.Decimal(totalPrice),
          currency,
          orderedAt,
        },
        include: {
          items: true,
        },
      });
    }

    const lineItems = this.parseLineItems(payload.line_items);

    const order = await this.prisma.order.create({
      data: {
        tenantId: input.tenantId,
        storeId: input.storeId,
        externalOrderId,
        orderNumber,
        status: OrderStatus.NEW,
        paymentStatus,
        fulfillmentStatus,
        totalAmount: new Prisma.Decimal(totalPrice),
        currency,
        orderedAt,
        items: {
          create: lineItems,
        },
      },
      include: {
        items: true,
      },
    });

    try {
      await this.inventoryService.reserveOrder({
        tenantId: input.tenantId,
        storeId: input.storeId,
        orderId: order.id,
      });
    } catch (error) {
      await this.prisma.order.update({
        where: {
          id: order.id,
        },
        data: {
          status: OrderStatus.FAILED,
        },
      });

      
      const failedItem = order.items[0];

      if (failedItem) {
        const failure = await this.orderFailureExceptionService.detectAndRaise({
          tenantId: input.tenantId,
          storeId: input.storeId,
          orderId: order.id,
          orderNumber: order.orderNumber,
          orderItemId: failedItem.id,
          sku: failedItem.sku,
          requestedQty: failedItem.quantity,
        });

        if (failure.detection.detected) {
          if (!failure.exception?.id) {
            throw new Error(
              "Detected order business failure did not return an operational exception ID",
            );
          }

          throw new OrderBusinessFailureError(
            error instanceof Error ? error.message : String(error),
            failure.exception.id,
            order.id,
          );
        }
      }

      throw error;
    }

    return this.prisma.order.findUniqueOrThrow({
      where: {
        id: order.id,
      },
      include: {
        items: true,
      },
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

    return value.map((rawItem, index) => {
      const item = rawItem as Record<string, unknown>;

      const externalLineItemId =
        this.requireShopifyString(
          item.id,
          `order.line_items[${index}].id`,
        );

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







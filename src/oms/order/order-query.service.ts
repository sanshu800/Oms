import { Injectable } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class OrderQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async getOrderById(input: {
    tenantId: string;
    storeId: string;
    orderId: string;
  }) {
    return this.prisma.order.findFirst({
      where: {
        id: input.orderId,
        tenantId: input.tenantId,
        storeId: input.storeId,
      },
    });
  }

  /**
   * Full read of an order for investigation purposes: line items,
   * inventory reservations, and fulfillment/shipment history.
   * Read-only, tenant/store scoped like every other query here.
   */
  async getOrderWithDetails(input: {
    tenantId: string;
    storeId: string;
    orderId: string;
  }) {
    return this.prisma.order.findFirst({
      where: {
        id: input.orderId,
        tenantId: input.tenantId,
        storeId: input.storeId,
      },
      include: {
        items: true,
        reservations: true,
        fulfillments: {
          include: {
            items: true,
            shipments: {
              include: {
                items: true,
              },
            },
          },
        },
      },
    });
  }

  async getOrderByExternalId(input: {
    tenantId: string;
    storeId: string;
    externalOrderId: string;
  }) {
    return this.prisma.order.findFirst({
      where: {
        tenantId: input.tenantId,
        storeId: input.storeId,
        externalOrderId: input.externalOrderId,
      },
    });
  }

  async listOrders(input: {
    tenantId: string;
    storeId: string;
    status?: OrderStatus;
    from?: Date;
    to?: Date;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(input.page ?? 1, 1);
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);

    const where: Prisma.OrderWhereInput = {
      tenantId: input.tenantId,
      storeId: input.storeId,

      ...(input.status
        ? {
            status: input.status,
          }
        : {}),

      ...(input.from || input.to
        ? {
            orderedAt: {
              ...(input.from ? { gte: input.from } : {}),
              ...(input.to ? { lte: input.to } : {}),
            },
          }
        : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        orderBy: {
          updatedAt: 'desc',
        },
        skip: (page - 1) * limit,
        take: limit,
      }),

      this.prisma.order.count({
        where,
      }),
    ]);

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getFailedOrders(input: {
    tenantId: string;
    storeId: string;
    page?: number;
    limit?: number;
  }) {
    return this.listOrders({
      ...input,
      status: OrderStatus.FAILED,
    });
  }

  async getOperationalOrders(input: {
    tenantId: string;
    storeId: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(input.page ?? 1, 1);
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);

    const statuses: OrderStatus[] = [
      OrderStatus.PROCESSING,
      OrderStatus.READY_TO_FULFILL,
      OrderStatus.FULFILLING,
      OrderStatus.FAILED,
    ];

    const where: Prisma.OrderWhereInput = {
      tenantId: input.tenantId,
      storeId: input.storeId,
      status: {
        in: statuses,
      },
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        orderBy: {
          updatedAt: 'asc',
        },
        skip: (page - 1) * limit,
        take: limit,
      }),

      this.prisma.order.count({
        where,
      }),
    ]);

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }
}
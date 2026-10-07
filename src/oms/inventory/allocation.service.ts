import { Injectable } from '@nestjs/common';
import {
  InventoryMovementType,
  InventoryReservationStatus,
  Prisma,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { tenantContextStorage } from '../../prisma/tenant-context';

@Injectable()
export class AllocationService {
  constructor(private readonly prisma: PrismaService) {}

  async reserveOrder(input: {
    tenantId: string;
    storeId: string;
    orderId: string;
  }) {
    return this.withSerializableRetry(input.tenantId, async (tx) => {
      const order = await tx.order.findFirst({
        where: {
          id: input.orderId,
          tenantId: input.tenantId,
          storeId: input.storeId,
        },
        include: {
          items: true,
        },
      });

      if (!order) {
        throw new Error('Order not found for inventory allocation');
      }

      const invalidItem = order.items.find(
        (item) => !Number.isInteger(item.quantity) || item.quantity < 0,
      );
      if (invalidItem) {
        throw new Error(`Invalid quantity for SKU: ${invalidItem.sku}`);
      }

      // A zero quantity is a retained historical line removed by Shopify.
      // It must not participate in a new stock allocation.
      const reservableItems = order.items.filter(
        (item) => item.quantity > 0,
      );
      if (reservableItems.length === 0) {
        return {
          reserved: false,
          reason: 'NO_LINE_ITEMS',
          reservationCount: 0,
        };
      }

      let reservationCount = 0;

      for (const orderItem of reservableItems) {

        const inventoryItem = await tx.inventoryItem.findUnique({
          where: {
            tenantId_sku: {
              tenantId: input.tenantId,
              sku: orderItem.sku.trim(),
            },
          },
        });

        if (!inventoryItem || !inventoryItem.active) {
          throw new Error(
            `Inventory item not found for SKU: ${orderItem.sku}`,
          );
        }

        await tx.orderItem.update({
          where: {
            id: orderItem.id,
          },
          data: {
            inventoryItemId: inventoryItem.id,
          },
        });

        const existingReservations =
          await tx.inventoryReservation.findMany({
            where: {
              tenantId: input.tenantId,
              storeId: input.storeId,
              orderItemId: orderItem.id,
            },
            orderBy: {
              createdAt: 'asc',
            },
          });

        const alreadyCovered = existingReservations
          .filter(
            (reservation) =>
              reservation.status ===
                InventoryReservationStatus.ACTIVE ||
              reservation.status ===
                InventoryReservationStatus.COMMITTED ||
              reservation.status ===
                InventoryReservationStatus.SHIPPED,
          )
          .reduce(
            (total, reservation) => total + reservation.quantity,
            0,
          );

        const remaining =
          orderItem.quantity - alreadyCovered;

        if (remaining <= 0) {
          reservationCount += existingReservations.length;
          continue;
        }

        const balances = await tx.inventoryBalance.findMany({
          where: {
            inventoryItemId: inventoryItem.id,
            location: {
              tenantId: input.tenantId,
              active: true,
            },
            availableQty: {
              gt: 0,
            },
          },
          include: {
            location: true,
          },
          orderBy: [
            {
              availableQty: 'asc',
            },
            {
              locationId: 'asc',
            },
          ],
        });

        const totalAvailable = balances.reduce(
          (total, balance) =>
            total + balance.availableQty,
          0,
        );

        if (totalAvailable < remaining) {
          throw new Error(
            `Insufficient inventory for SKU ${orderItem.sku}: requested ${remaining}, available ${totalAvailable}`,
          );
        }

        /*
         * Allocation strategy:
         *
         * 1. Prefer one location that can fulfill the
         *    entire quantity.
         *
         * 2. Otherwise split across locations.
         *
         * 3. For a single-location match, use the smallest
         *    sufficient balance to avoid unnecessary stock
         *    fragmentation.
         *
         * 4. For split allocation, consume largest balances
         *    first to minimize the number of locations.
         */

        const singleLocation = balances.find(
          (balance) =>
            balance.availableQty >= remaining,
        );

        const allocations: Array<{
          locationId: string;
          quantity: number;
        }> = [];

        if (singleLocation) {
          allocations.push({
            locationId: singleLocation.locationId,
            quantity: remaining,
          });
        } else {
          let outstanding = remaining;

          const splitBalances = [...balances].sort(
            (a, b) =>
              b.availableQty - a.availableQty ||
              a.locationId.localeCompare(b.locationId),
          );

          for (const balance of splitBalances) {
            if (outstanding <= 0) break;

            const quantity = Math.min(
              outstanding,
              balance.availableQty,
            );

            if (quantity <= 0) continue;

            allocations.push({
              locationId: balance.locationId,
              quantity,
            });

            outstanding -= quantity;
          }

          if (outstanding > 0) {
            throw new Error(
              `Allocation failed for SKU ${orderItem.sku}`,
            );
          }
        }

        for (const allocation of allocations) {
          const updated =
            await tx.inventoryBalance.updateMany({
              where: {
                inventoryItemId: inventoryItem.id,
                locationId: allocation.locationId,
                availableQty: {
                  gte: allocation.quantity,
                },
              },
              data: {
                availableQty: {
                  decrement: allocation.quantity,
                },
                reservedQty: {
                  increment: allocation.quantity,
                },
              },
            });

          if (updated.count !== 1) {
            throw new Error(
              `Inventory changed during allocation for SKU ${orderItem.sku}`,
            );
          }

          const reservation =
            await tx.inventoryReservation.create({
              data: {
                tenantId: input.tenantId,
                storeId: input.storeId,
                orderId: order.id,
                orderItemId: orderItem.id,
                inventoryItemId: inventoryItem.id,
                locationId: allocation.locationId,
                quantity: allocation.quantity,
                status:
                  InventoryReservationStatus.ACTIVE,
              },
            });

          await tx.inventoryMovement.create({
            data: {
              tenantId: input.tenantId,
              storeId: input.storeId,
              inventoryItemId: inventoryItem.id,
              locationId: allocation.locationId,
              orderId: order.id,
              orderItemId: orderItem.id,
              reservationId: reservation.id,
              type: InventoryMovementType.RESERVATION,
              quantity: allocation.quantity,
              reference: `ORDER:${order.id}`,
              metadata: {
                allocationType:
                  allocations.length === 1
                    ? 'SINGLE_LOCATION'
                    : 'SPLIT_LOCATION',
              },
            },
          });

          reservationCount++;
        }
      }

      return {
        reserved: true,
        reservationCount,
      };
    });
  }

  private async withSerializableRetry<T>(
    tenantId: string,
    operation: (
      tx: Prisma.TransactionClient,
    ) => Promise<T>,
  ): Promise<T> {
    const maxRetries = 3;

    for (
      let attempt = 1;
      attempt <= maxRetries;
      attempt++
    ) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            // Stamp RLS's session var, and register this exact tx in
            // the ambient context so any nested this.prisma.x.y()
            // call made during this transaction (from this service or
            // anything it calls into) reuses it instead of trying to
            // open a second, independent transaction that would
            // contend for the same locks and deadlock against this one.
            await tx.$executeRawUnsafe(
              `SELECT set_config('app.tenant_id', $1, true)`,
              tenantId,
            );

            return tenantContextStorage.run(
              { tenantId, tx },
              () => operation(tx),
            );
          },
          {
            isolationLevel:
              Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 5000,
            timeout: 10000,
          },
        );
      } catch (error) {
        const code =
          error &&
          typeof error === 'object' &&
          'code' in error
            ? String(
                (error as { code: unknown }).code,
              )
            : '';

        if (
          code !== 'P2034' ||
          attempt === maxRetries
        ) {
          throw error;
        }
      }
    }

    throw new Error(
      'Inventory allocation transaction failed',
    );
  }
}

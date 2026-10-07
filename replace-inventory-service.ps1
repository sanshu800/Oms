$path = ".\src\oms\inventory\inventory.service.ts"

@"
import { Injectable } from '@nestjs/common';
import {
  InventoryMovementType,
  InventoryReservationStatus,
  Prisma,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  async createItem(input: {
    tenantId: string;
    storeId: string;
    sku: string;
    name: string;
    initialAvailableQty?: number;
    locationId?: string;
    shopifyInventoryItemId?: string;
  }) {
    const sku = this.requireSku(input.sku);
    const initialAvailableQty = input.initialAvailableQty ?? 0;

    this.requireNonNegativeInteger(
      initialAvailableQty,
      'initialAvailableQty',
    );

    const existing = await this.prisma.inventoryItem.findUnique({
      where: {
        tenantId_sku: {
          tenantId: input.tenantId,
          sku,
        },
      },
      include: {
        balances: {
          include: {
            location: true,
          },
        },
        externalReferences: true,
      },
    });

    if (existing) {
      return existing;
    }

    const location = await this.resolveLocation({
      tenantId: input.tenantId,
      locationId: input.locationId,
    });

    const item = await this.prisma.inventoryItem.create({
      data: {
        tenantId: input.tenantId,
        sku,
        name: input.name.trim(),
        balances: {
          create: {
            locationId: location.id,
            availableQty: initialAvailableQty,
          },
        },
      },
      include: {
        balances: {
          include: {
            location: true,
          },
        },
        externalReferences: true,
      },
    });

    if (input.shopifyInventoryItemId) {
      await this.prisma.inventoryItemExternalReference.create({
        data: {
          tenantId: input.tenantId,
          storeId: input.storeId,
          inventoryItemId: item.id,
          platform: 'SHOPIFY',
          externalId: input.shopifyInventoryItemId,
        },
      });

      return this.prisma.inventoryItem.findUniqueOrThrow({
        where: { id: item.id },
        include: {
          balances: {
            include: {
              location: true,
            },
          },
          externalReferences: true,
        },
      });
    }

    return item;
  }

  async getItem(input: {
    tenantId: string;
    storeId: string;
    sku: string;
  }) {
    return this.prisma.inventoryItem.findUnique({
      where: {
        tenantId_sku: {
          tenantId: input.tenantId,
          sku: this.requireSku(input.sku),
        },
      },
      include: {
        balances: {
          include: {
            location: true,
          },
        },
        externalReferences: {
          where: {
            storeId: input.storeId,
          },
        },
      },
    });
  }

  async listItems(input: {
    tenantId: string;
    storeId: string;
  }) {
    return this.prisma.inventoryItem.findMany({
      where: {
        tenantId: input.tenantId,
      },
      include: {
        balances: {
          include: {
            location: true,
          },
        },
        externalReferences: {
          where: {
            storeId: input.storeId,
          },
        },
      },
      orderBy: {
        sku: 'asc',
      },
    });
  }

  async adjustStock(input: {
    tenantId: string;
    storeId: string;
    sku: string;
    quantity: number;
    locationId?: string;
    reference?: string;
    metadata?: Prisma.InputJsonValue;
  }) {
    this.requireNonZeroInteger(input.quantity, 'quantity');

    return this.withSerializableRetry(async (tx) => {
      const item = await tx.inventoryItem.findUnique({
        where: {
          tenantId_sku: {
            tenantId: input.tenantId,
            sku: this.requireSku(input.sku),
          },
        },
      });

      if (!item || !item.active) {
        throw new Error(`Inventory item not found: ${input.sku}`);
      }

      const location = await this.resolveLocation(
        {
          tenantId: input.tenantId,
          locationId: input.locationId,
        },
        tx,
      );

      await tx.inventoryBalance.upsert({
        where: {
          inventoryItemId_locationId: {
            inventoryItemId: item.id,
            locationId: location.id,
          },
        },
        create: {
          inventoryItemId: item.id,
          locationId: location.id,
          availableQty: 0,
        },
        update: {},
      });

      const quantity = Math.abs(input.quantity);

      const updated =
        input.quantity > 0
          ? await tx.inventoryBalance.update({
              where: {
                inventoryItemId_locationId: {
                  inventoryItemId: item.id,
                  locationId: location.id,
                },
              },
              data: {
                availableQty: {
                  increment: quantity,
                },
              },
            })
          : await this.decreaseAvailable(
              tx,
              item.id,
              location.id,
              quantity,
            );

      await tx.inventoryMovement.create({
        data: {
          tenantId: input.tenantId,
          storeId: input.storeId,
          inventoryItemId: item.id,
          locationId: location.id,
          type:
            input.quantity > 0
              ? InventoryMovementType.ADJUSTMENT_IN
              : InventoryMovementType.ADJUSTMENT_OUT,
          quantity,
          reference: input.reference,
          metadata: input.metadata,
        },
      });

      return updated;
    });
  }

  async reserveOrder(input: {
    tenantId: string;
    storeId: string;
    orderId: string;
  }) {
    return this.withSerializableRetry(async (tx) => {
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
        throw new Error('Order not found for inventory reservation');
      }

      if (order.items.length === 0) {
        return {
          reserved: false,
          reason: 'NO_LINE_ITEMS',
          reservationCount: 0,
        };
      }

      let reservationCount = 0;

      for (const orderItem of order.items) {
        this.requirePositiveInteger(
          orderItem.quantity,
          `quantity for ${orderItem.sku}`,
        );

        const existingReservations =
          await tx.inventoryReservation.findMany({
            where: {
              tenantId: input.tenantId,
              storeId: input.storeId,
              orderItemId: orderItem.id,
              status: {
                in: [
                  InventoryReservationStatus.ACTIVE,
                  InventoryReservationStatus.COMMITTED,
                  InventoryReservationStatus.SHIPPED,
                ],
              },
            },
          });

        const alreadyReserved = existingReservations.reduce(
          (sum, reservation) => sum + reservation.quantity,
          0,
        );

        const remaining =
          orderItem.quantity - alreadyReserved;

        if (remaining <= 0) {
          reservationCount += existingReservations.length;
          continue;
        }

        const inventoryItem =
          await tx.inventoryItem.findUnique({
            where: {
              tenantId_sku: {
                tenantId: input.tenantId,
                sku: this.requireSku(orderItem.sku),
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

        const balances =
          await tx.inventoryBalance.findMany({
            where: {
              inventoryItemId: inventoryItem.id,
              availableQty: {
                gt: 0,
              },
              location: {
                tenantId: input.tenantId,
                active: true,
              },
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
          (sum, balance) => sum + balance.availableQty,
          0,
        );

        if (totalAvailable < remaining) {
          throw new Error(
            `Insufficient inventory for SKU: ${orderItem.sku}`,
          );
        }

        const singleLocation = balances.find(
          (balance) => balance.availableQty >= remaining,
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
            if (outstanding <= 0) {
              break;
            }

            const quantity = Math.min(
              outstanding,
              balance.availableQty,
            );

            if (quantity <= 0) {
              continue;
            }

            allocations.push({
              locationId: balance.locationId,
              quantity,
            });

            outstanding -= quantity;
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
              `Inventory changed during allocation for SKU: ${orderItem.sku}`,
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
                status: InventoryReservationStatus.ACTIVE,
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

  async releaseOrder(input: {
    tenantId: string;
    storeId: string;
    orderId: string;
  }) {
    return this.withSerializableRetry(async (tx) => {
      const reservations =
        await tx.inventoryReservation.findMany({
          where: {
            tenantId: input.tenantId,
            storeId: input.storeId,
            orderId: input.orderId,
            status: InventoryReservationStatus.ACTIVE,
          },
        });

      if (reservations.length === 0) {
        return {
          released: false,
          reservationCount: 0,
        };
      }

      for (const reservation of reservations) {
        await tx.inventoryBalance.update({
          where: {
            inventoryItemId_locationId: {
              inventoryItemId: reservation.inventoryItemId,
              locationId: reservation.locationId,
            },
          },
          data: {
            availableQty: {
              increment: reservation.quantity,
            },
            reservedQty: {
              decrement: reservation.quantity,
            },
          },
        });

        await tx.inventoryReservation.update({
          where: {
            id: reservation.id,
          },
          data: {
            status: InventoryReservationStatus.RELEASED,
          },
        });

        await tx.inventoryMovement.create({
          data: {
            tenantId: input.tenantId,
            storeId: input.storeId,
            inventoryItemId: reservation.inventoryItemId,
            locationId: reservation.locationId,
            orderId: reservation.orderId,
            orderItemId: reservation.orderItemId,
            reservationId: reservation.id,
            type: InventoryMovementType.RELEASE,
            quantity: reservation.quantity,
            reference: `ORDER:${reservation.orderId}`,
          },
        });
      }

      return {
        released: true,
        reservationCount: reservations.length,
      };
    });
  }

  async commitOrder(input: {
    tenantId: string;
    storeId: string;
    orderId: string;
  }) {
    return this.withSerializableRetry(async (tx) => {
      const reservations =
        await tx.inventoryReservation.findMany({
          where: {
            tenantId: input.tenantId,
            storeId: input.storeId,
            orderId: input.orderId,
            status: InventoryReservationStatus.ACTIVE,
          },
        });

      if (reservations.length === 0) {
        return {
          committed: false,
          reservationCount: 0,
        };
      }

      for (const reservation of reservations) {
        await tx.inventoryBalance.update({
          where: {
            inventoryItemId_locationId: {
              inventoryItemId: reservation.inventoryItemId,
              locationId: reservation.locationId,
            },
          },
          data: {
            reservedQty: {
              decrement: reservation.quantity,
            },
            committedQty: {
              increment: reservation.quantity,
            },
          },
        });

        await tx.inventoryReservation.update({
          where: {
            id: reservation.id,
          },
          data: {
            status: InventoryReservationStatus.COMMITTED,
          },
        });

        await tx.inventoryMovement.create({
          data: {
            tenantId: input.tenantId,
            storeId: input.storeId,
            inventoryItemId: reservation.inventoryItemId,
            locationId: reservation.locationId,
            orderId: reservation.orderId,
            orderItemId: reservation.orderItemId,
            reservationId: reservation.id,
            type: InventoryMovementType.COMMIT,
            quantity: reservation.quantity,
            reference: `ORDER:${reservation.orderId}`,
          },
        });
      }

      return {
        committed: true,
        reservationCount: reservations.length,
      };
    });
  }

  async shipOrder(input: {
    tenantId: string;
    storeId: string;
    orderId: string;
  }) {
    return this.withSerializableRetry(async (tx) => {
      const reservations =
        await tx.inventoryReservation.findMany({
          where: {
            tenantId: input.tenantId,
            storeId: input.storeId,
            orderId: input.orderId,
            status: InventoryReservationStatus.COMMITTED,
          },
        });

      if (reservations.length === 0) {
        return {
          shipped: false,
          reservationCount: 0,
        };
      }

      for (const reservation of reservations) {
        await tx.inventoryBalance.update({
          where: {
            inventoryItemId_locationId: {
              inventoryItemId: reservation.inventoryItemId,
              locationId: reservation.locationId,
            },
          },
          data: {
            committedQty: {
              decrement: reservation.quantity,
            },
          },
        });

        await tx.inventoryReservation.update({
          where: {
            id: reservation.id,
          },
          data: {
            status: InventoryReservationStatus.SHIPPED,
          },
        });

        await tx.inventoryMovement.create({
          data: {
            tenantId: input.tenantId,
            storeId: input.storeId,
            inventoryItemId: reservation.inventoryItemId,
            locationId: reservation.locationId,
            orderId: reservation.orderId,
            orderItemId: reservation.orderItemId,
            reservationId: reservation.id,
            type: InventoryMovementType.SHIP,
            quantity: reservation.quantity,
            reference: `ORDER:${reservation.orderId}`,
          },
        });
      }

      return {
        shipped: true,
        reservationCount: reservations.length,
      };
    });
  }

  async getMovements(input: {
    tenantId: string;
    storeId: string;
    sku?: string;
    orderId?: string;
  }) {
    return this.prisma.inventoryMovement.findMany({
      where: {
        tenantId: input.tenantId,
        storeId: input.storeId,
        ...(input.orderId ? { orderId: input.orderId } : {}),
        ...(input.sku
          ? {
              inventoryItem: {
                sku: this.requireSku(input.sku),
              },
            }
          : {}),
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async setShopifyInventoryMapping(input: {
    tenantId: string;
    storeId: string;
    sku: string;
    shopifyInventoryItemId: string;
  }) {
    const item = await this.prisma.inventoryItem.findUnique({
      where: {
        tenantId_sku: {
          tenantId: input.tenantId,
          sku: this.requireSku(input.sku),
        },
      },
    });

    if (!item) {
      throw new Error(`Inventory item not found: ${input.sku}`);
    }

    const existing =
      await this.prisma.inventoryItemExternalReference.findFirst({
        where: {
          storeId: input.storeId,
          platform: 'SHOPIFY',
          externalId: input.shopifyInventoryItemId,
          NOT: {
            inventoryItemId: item.id,
          },
        },
      });

    if (existing) {
      throw new Error(
        `Shopify inventory item is already mapped to SKU: ${item.sku}`,
      );
    }

    return this.prisma.inventoryItemExternalReference.upsert({
      where: {
        storeId_platform_externalId: {
          storeId: input.storeId,
          platform: 'SHOPIFY',
          externalId: input.shopifyInventoryItemId,
        },
      },
      create: {
        tenantId: input.tenantId,
        storeId: input.storeId,
        inventoryItemId: item.id,
        platform: 'SHOPIFY',
        externalId: input.shopifyInventoryItemId,
      },
      update: {
        inventoryItemId: item.id,
      },
    });
  }

  async syncShopifyInventory(input: {
    tenantId: string;
    storeId: string;
    shopifyInventoryItemId: string;
    availableQty: number;
    locationId?: string;
    reference?: string;
    metadata?: Prisma.InputJsonValue;
  }) {
    this.requireNonNegativeInteger(
      input.availableQty,
      'availableQty',
    );

    return this.withSerializableRetry(async (tx) => {
      const mapping =
        await tx.inventoryItemExternalReference.findUnique({
          where: {
            storeId_platform_externalId: {
              storeId: input.storeId,
              platform: 'SHOPIFY',
              externalId: input.shopifyInventoryItemId,
            },
          },
        });

      if (!mapping || mapping.tenantId !== input.tenantId) {
        throw new Error(
          `No OMS inventory mapping for Shopify inventory item ${input.shopifyInventoryItemId}`,
        );
      }

      const item =
        await tx.inventoryItem.findUnique({
          where: {
            id: mapping.inventoryItemId,
          },
        });

      if (!item || !item.active) {
        throw new Error(
          `No active inventory item for Shopify inventory item ${input.shopifyInventoryItemId}`,
        );
      }

      const location = await this.resolveLocation(
        {
          tenantId: input.tenantId,
          locationId: input.locationId,
        },
        tx,
      );

      const balance =
        await tx.inventoryBalance.upsert({
          where: {
            inventoryItemId_locationId: {
              inventoryItemId: item.id,
              locationId: location.id,
            },
          },
          create: {
            inventoryItemId: item.id,
            locationId: location.id,
            availableQty: input.availableQty,
          },
          update: {
            availableQty: input.availableQty,
          },
        });

      await tx.inventoryMovement.create({
        data: {
          tenantId: input.tenantId,
          storeId: input.storeId,
          inventoryItemId: item.id,
          locationId: location.id,
          type: InventoryMovementType.RECEIPT,
          quantity: input.availableQty,
          reference: input.reference,
          metadata: input.metadata,
        },
      });

      return balance;
    });
  }

  private async decreaseAvailable(
    tx: Prisma.TransactionClient,
    inventoryItemId: string,
    locationId: string,
    quantity: number,
  ) {
    const updated =
      await tx.inventoryBalance.updateMany({
        where: {
          inventoryItemId,
          locationId,
          availableQty: {
            gte: quantity,
          },
        },
        data: {
          availableQty: {
            decrement: quantity,
          },
        },
      });

    if (updated.count !== 1) {
      throw new Error(
        'Insufficient available inventory',
      );
    }

    return tx.inventoryBalance.findUniqueOrThrow({
      where: {
        inventoryItemId_locationId: {
          inventoryItemId,
          locationId,
        },
      },
    });
  }

  private async resolveLocation(
    input: {
      tenantId: string;
      locationId?: string;
    },
    tx?: Prisma.TransactionClient,
  ) {
    const client = tx ?? this.prisma;

    if (input.locationId) {
      const location =
        await client.inventoryLocation.findFirst({
          where: {
            id: input.locationId,
            tenantId: input.tenantId,
            active: true,
          },
        });

      if (!location) {
        throw new Error(
          `Inventory location not found: ${input.locationId}`,
        );
      }

      return location;
    }

    const locations =
      await client.inventoryLocation.findMany({
        where: {
          tenantId: input.tenantId,
          active: true,
        },
        orderBy: {
          createdAt: 'asc',
        },
        take: 2,
      });

    if (locations.length === 0) {
      return client.inventoryLocation.create({
        data: {
          tenantId: input.tenantId,
          code: 'DEFAULT',
          name: 'Default Inventory Location',
        },
      });
    }

    if (locations.length > 1) {
      throw new Error(
        'locationId is required when the tenant has multiple active inventory locations',
      );
    }

    return locations[0];
  }

  private async withSerializableRetry<T>(
    operation: (
      tx: Prisma.TransactionClient,
    ) => Promise<T>,
  ): Promise<T> {
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.prisma.$transaction(
          operation,
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
            ? String((error as { code: unknown }).code)
            : '';

        if (code !== 'P2034' || attempt === maxRetries) {
          throw error;
        }
      }
    }

    throw new Error('Inventory transaction failed');
  }

  private requireSku(value: string): string {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error('SKU is required');
    }

    return value.trim();
  }

  private requirePositiveInteger(
    value: number,
    field: string,
  ): void {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${field} must be a positive integer`);
    }
  }

  private requireNonNegativeInteger(
    value: number,
    field: string,
  ): void {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${field} must be a non-negative integer`);
    }
  }

  private requireNonZeroInteger(
    value: number,
    field: string,
  ): void {
    if (!Number.isInteger(value) || value === 0) {
      throw new Error(`${field} must be a non-zero integer`);
    }
  }
}
"@ | Set-Content $path -Encoding utf8

npx prisma generate
npx prisma validate
npm run build 2>&1 | Tee-Object -FilePath .\techmart-build-after-inventory-refactor.txt

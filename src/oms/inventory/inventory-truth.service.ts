import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

export type InventoryTruthLocation = {
  locationId: string;
  locationCode: string;
  locationName: string;
  availableQty: number;
  reservedQty: number;
  committedQty: number;
  onHandQty: number;
  updatedAt: Date;
  isStale: boolean;
};

export type InventoryTruth = {
  inventoryItemId: string;
  sku: string;
  name: string;
  availableQty: number;
  reservedQty: number;
  committedQty: number;
  onHandQty: number;
  locationCount: number;
  isStale: boolean;
  locations: InventoryTruthLocation[];
};

@Injectable()
export class InventoryTruthService {
  constructor(private readonly prisma: PrismaService) {}

  async getSkuTruth(input: {
    tenantId: string;
    sku: string;
    maxAgeMinutes?: number;
  }): Promise<InventoryTruth | null> {
    const sku = input.sku.trim();

    if (!sku) {
      throw new Error('sku is required');
    }

    const item = await this.prisma.inventoryItem.findUnique({
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
          orderBy: {
            locationId: 'asc',
          },
        },
      },
    });

    if (!item) {
      return null;
    }

    const maxAgeMinutes = input.maxAgeMinutes;
    const now = Date.now();

    const locations = item.balances.map((balance) => {
      const calculatedOnHand =
        balance.availableQty +
        balance.reservedQty +
        balance.committedQty;

      if (calculatedOnHand < 0) {
        throw new Error(
          `Invalid inventory balance for SKU ${item.sku} at location ${balance.location.name}: on-hand quantity cannot be negative`,
        );
      }
      const onHandQty = calculatedOnHand;

      const isStale =
        typeof maxAgeMinutes === 'number'
          ? now - balance.updatedAt.getTime() >
            maxAgeMinutes * 60 * 1000
          : false;

      return {
        locationId: balance.locationId,
        locationCode: balance.location.code,
        locationName: balance.location.name,
        availableQty: balance.availableQty,
        reservedQty: balance.reservedQty,
        committedQty: balance.committedQty,
        onHandQty,
        updatedAt: balance.updatedAt,
        isStale,
      };
    });

    const availableQty = locations.reduce(
      (total, location) => total + location.availableQty,
      0,
    );

    const reservedQty = locations.reduce(
      (total, location) => total + location.reservedQty,
      0,
    );

    const committedQty = locations.reduce(
      (total, location) => total + location.committedQty,
      0,
    );

    const aggregateOnHandQty =
      availableQty +
      reservedQty +
      committedQty;

    if (
      aggregateOnHandQty !==
      locations.reduce((total, location) => total + location.onHandQty, 0)
    ) {
      throw new Error(
        `Inventory truth invariant violated for SKU ${item.sku}`,
      );
    }

    return {
      inventoryItemId: item.id,
      sku: item.sku,
      name: item.name,
      availableQty,
      reservedQty,
      committedQty,
      onHandQty:
        availableQty +
        reservedQty +
        committedQty,
      locationCount: locations.length,
      isStale: locations.some(
        (location) => location.isStale,
      ),
      locations,
    };
  }
}


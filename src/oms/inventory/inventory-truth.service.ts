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

/**
 * One reservation-ledger row that currently holds or has committed stock of
 * the item. `status` is the canonical `InventoryReservationStatus` value
 * verbatim; only the stock-holding statuses are returned —
 * ACTIVE (reserved) and COMMITTED (allocated). RELEASED and SHIPPED rows
 * are terminal and are excluded as unnecessary detail.
 *
 * `quantity` is that ledger row's quantity (per row, not summed); one entry
 * is returned per reservation row, ordered by orderId then row id.
 */
export type InventoryTruthReservation = {
  orderId: string;
  quantity: number;
  status: "ACTIVE" | "COMMITTED";
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
  /**
   * Stock-holding reservation rows for this item (ACTIVE + COMMITTED).
   * Scoped to the tenant; scoped to the store as well when the caller
   * passes `storeId`. Read-only evidence — it is not proof that a
   * reservation is unchanged by execution time (pre-execution
   * revalidation remains the authority for that).
   */
  reservations: InventoryTruthReservation[];
};

@Injectable()
export class InventoryTruthService {
  constructor(private readonly prisma: PrismaService) {}

  async getSkuTruth(input: {
    tenantId: string;
    sku: string;
    maxAgeMinutes?: number;
    /**
     * Optional store scope for the reservation evidence: when present,
     * only reservation rows of this store are returned (tenant scope is
     * always enforced). Callers that do not need reservation details can
     * omit it — the aggregate truth is unchanged either way.
     */
    storeId?: string;
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

    // Reservation evidence: the stock-holding ledger rows (ACTIVE +
    // COMMITTED) for this item, within the authorized tenant (always) and
    // store (when requested) scope. Terminal rows (RELEASED, SHIPPED) are
    // excluded — only rows that hold or have committed stock are relevant
    // to shortage and reservation-conflict investigation.
    const reservations = await this.prisma.inventoryReservation.findMany({
      where: {
        tenantId: input.tenantId,
        inventoryItemId: item.id,
        status: { in: ["ACTIVE", "COMMITTED"] },
        ...(input.storeId ? { storeId: input.storeId } : {}),
      },
      orderBy: [{ orderId: "asc" }, { id: "asc" }],
      select: {
        orderId: true,
        quantity: true,
        status: true,
      },
    });

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
      reservations: reservations.map((row) => ({
        orderId: row.orderId,
        quantity: row.quantity,
        status: row.status as "ACTIVE" | "COMMITTED",
      })),
    };
  }
}


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
 *
 * Scope: rows are limited to the authorized tenant (always) and store (when
 * the caller passes `storeId`) — the AI tool layer's uniform (tenantId,
 * storeId) read contract. Cross-store rows are never exposed here.
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
  /**
   * Aggregates below are TENANT-WIDE by construction: balances live on
   * (item, location) and locations belong to the tenant — there is no
   * store dimension in the canonical balance model, and every store's
   * reservations move them. Do not read them as store-scoped figures.
   */
  availableQty: number;
  reservedQty: number;
  committedQty: number;
  onHandQty: number;
  locationCount: number;
  isStale: boolean;
  locations: InventoryTruthLocation[];
  /**
   * Which scope the `reservations` rows below cover: "STORE" when the
   * caller passed `storeId` (rows of that store only), otherwise "TENANT"
   * (all of the tenant's rows). Explicit because the aggregates above are
   * always tenant-wide — with "STORE" rows the two scopes differ.
   */
  reservationsScope: "STORE" | "TENANT";
  /**
   * Stock-holding reservation rows (ACTIVE + COMMITTED) within the scope
   * above. Read-only evidence — it is not proof that a reservation is
   * unchanged by execution time (pre-execution revalidation remains the
   * authority for that).
   */
  reservations: InventoryTruthReservation[];
  /**
   * Explicit incompleteness markers: `reservedQty`/`committedQty` minus
   * the quantity explained by the returned rows. Non-zero values mean stock
   * is held OUTSIDE the authorized scope (e.g. by other stores of this
   * tenant, which this evidence set may not name) — or, if negative, that
   * the ledger and balances disagree. Cross-store holders are required to
   * explain the tenant-wide aggregates but are not authorized for a
   * store-scoped investigation, so the gap is quantified rather than the
   * foreign rows being exposed. Derived only from quantities already
   * present above. Zero when rows are tenant-scoped and consistent.
   */
  unexplainedReservedQty: number;
  unexplainedCommittedQty: number;
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

    const scopedActiveQty = reservations
      .filter((row) => row.status === "ACTIVE")
      .reduce((total, row) => total + row.quantity, 0);

    const scopedCommittedQty = reservations
      .filter((row) => row.status === "COMMITTED")
      .reduce((total, row) => total + row.quantity, 0);

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
      reservationsScope: input.storeId ? "STORE" : "TENANT",
      reservations: reservations.map((row) => ({
        orderId: row.orderId,
        quantity: row.quantity,
        status: row.status as "ACTIVE" | "COMMITTED",
      })),
      // Scope consistency: the aggregates are tenant-wide; the rows may be
      // store-scoped. Quantify — never silently paper over — the part of
      // the aggregate the authorized rows do not explain.
      unexplainedReservedQty: reservedQty - scopedActiveQty,
      unexplainedCommittedQty: committedQty - scopedCommittedQty,
    };
  }
}


import { describe, expect, it, vi } from 'vitest';

import { InventoryTruthService } from './inventory-truth.service';

describe('InventoryTruthService', () => {
  function createService(balances: unknown[], reservations: unknown[] = []) {
    const prisma = {
      inventoryItem: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'inventory-1',
          sku: 'sku-managed-1',
          name: 'The Multi-managed Snowboard',
          balances,
        }),
      },
      inventoryReservation: {
        findMany: vi.fn().mockResolvedValue(reservations),
      },
    };

    return {
      service: new InventoryTruthService(prisma as any),
      prisma,
    };
  }

  it('aggregates available inventory across locations', async () => {
    const { service } = createService([
      {
        inventoryItemId: 'inventory-1',
        locationId: 'location-1',
        availableQty: 10,
        reservedQty: 0,
        committedQty: 0,
        updatedAt: new Date(),
        location: {
          id: 'location-1',
          code: 'SHOP',
          name: 'Shop location',
        },
      },
      {
        inventoryItemId: 'inventory-1',
        locationId: 'location-2',
        availableQty: 50,
        reservedQty: 0,
        committedQty: 0,
        updatedAt: new Date(),
        location: {
          id: 'location-2',
          code: 'SNOW-CITY',
          name: 'Snow City Warehouse',
        },
      },
    ]);

    const result = await service.getSkuTruth({
      tenantId: 'tenant-1',
      sku: 'sku-managed-1',
    });

    expect(result).not.toBeNull();
    expect(result?.availableQty).toBe(60);
    expect(result?.reservedQty).toBe(0);
    expect(result?.committedQty).toBe(0);
    expect(result?.onHandQty).toBe(60);
    expect(result?.locationCount).toBe(2);
  });

  it('preserves per-location inventory truth', async () => {
    const { service } = createService([
      {
        inventoryItemId: 'inventory-1',
        locationId: 'location-1',
        availableQty: 10,
        reservedQty: 2,
        committedQty: 1,
        updatedAt: new Date(),
        location: {
          id: 'location-1',
          code: 'SHOP',
          name: 'Shop location',
        },
      },
    ]);

    const result = await service.getSkuTruth({
      tenantId: 'tenant-1',
      sku: 'sku-managed-1',
    });

    expect(result?.locations).toHaveLength(1);
    expect(result?.locations[0]).toMatchObject({
      availableQty: 10,
      reservedQty: 2,
      committedQty: 1,
      onHandQty: 13,
      locationName: 'Shop location',
    });
  });

  it('returns zero truth when a SKU has zero inventory', async () => {
    const { service } = createService([
      {
        inventoryItemId: 'inventory-1',
        locationId: 'location-1',
        availableQty: 0,
        reservedQty: 0,
        committedQty: 0,
        updatedAt: new Date(),
        location: {
          id: 'location-1',
          code: 'SHOP',
          name: 'Shop location',
        },
      },
    ]);

    const result = await service.getSkuTruth({
      tenantId: 'tenant-1',
      sku: 'sku-managed-1',
    });

    expect(result?.availableQty).toBe(0);
    expect(result?.onHandQty).toBe(0);
    expect(result?.isStale).toBe(false);
  });

  it('flags stale inventory when a freshness threshold is exceeded', async () => {
    const staleDate = new Date(Date.now() - 31 * 60 * 1000);

    const { service } = createService([
      {
        inventoryItemId: 'inventory-1',
        locationId: 'location-1',
        availableQty: 10,
        reservedQty: 0,
        committedQty: 0,
        updatedAt: staleDate,
        location: {
          id: 'location-1',
          code: 'SHOP',
          name: 'Shop location',
        },
      },
    ]);

    const result = await service.getSkuTruth({
      tenantId: 'tenant-1',
      sku: 'sku-managed-1',
      maxAgeMinutes: 30,
    });

    expect(result?.isStale).toBe(true);
    expect(result?.locations[0]?.isStale).toBe(true);
  });

  it('returns null for an unknown SKU', async () => {
    const prisma = {
      inventoryItem: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
    };

    const service = new InventoryTruthService(
      prisma as any,
    );

    const result = await service.getSkuTruth({
      tenantId: 'tenant-1',
      sku: 'does-not-exist',
    });

    expect(result).toBeNull();
  });

  // ---- reservation-holder evidence (Phase 1C) ----

  const singleBalance = [
    {
      inventoryItemId: 'inventory-1',
      locationId: 'location-1',
      availableQty: 5,
      reservedQty: 5,
      committedQty: 2,
      updatedAt: new Date(),
      location: { id: 'location-1', code: 'SHOP', name: 'Shop location' },
    },
  ];

  it('returns stock-holding reservation rows mapped to orderId/quantity/status', async () => {
    const { service, prisma } = createService(singleBalance, [
      { orderId: 'order-a', quantity: 5, status: 'ACTIVE' },
      { orderId: 'order-b', quantity: 2, status: 'COMMITTED' },
    ]);

    const result = await service.getSkuTruth({
      tenantId: 'tenant-1',
      sku: 'sku-managed-1',
    });

    expect(result?.reservations).toEqual([
      { orderId: 'order-a', quantity: 5, status: 'ACTIVE' },
      { orderId: 'order-b', quantity: 2, status: 'COMMITTED' },
    ]);

    // The query asks for exactly the stock-holding statuses (ACTIVE,
    // COMMITTED) of THIS tenant's item — terminal rows (RELEASED, SHIPPED)
    // are never requested.
    const where = (prisma.inventoryReservation.findMany as any).mock
      .calls[0][0].where;
    expect(where.tenantId).toBe('tenant-1');
    expect(where.inventoryItemId).toBe('inventory-1');
    expect(where.status).toEqual({ in: ['ACTIVE', 'COMMITTED'] });
  });

  it('scopes reservation evidence to the requested store when storeId is given', async () => {
    const { service, prisma } = createService(singleBalance, [
      { orderId: 'order-a', quantity: 5, status: 'ACTIVE' },
    ]);

    await service.getSkuTruth({
      tenantId: 'tenant-1',
      sku: 'sku-managed-1',
      storeId: 'store-1',
    });

    const where = (prisma.inventoryReservation.findMany as any).mock
      .calls[0][0].where;
    expect(where.storeId).toBe('store-1');
  });

  it('does not filter by store when the caller does not request store scope', async () => {
    const { service, prisma } = createService(singleBalance, [
      { orderId: 'order-a', quantity: 5, status: 'ACTIVE' },
    ]);

    await service.getSkuTruth({
      tenantId: 'tenant-1',
      sku: 'sku-managed-1',
    });

    const where = (prisma.inventoryReservation.findMany as any).mock
      .calls[0][0].where;
    expect('storeId' in where).toBe(false);
  });
});


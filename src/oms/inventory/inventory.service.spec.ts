import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

vi.mock('@prisma/client', () => import('../../../test-utils/prisma-client.mock'));

import { InventoryService } from './inventory.service';
import { AllocationService } from './allocation.service';

describe('InventoryService', () => {
  let service: InventoryService;

  const prisma = {
    inventoryItem: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },

    inventoryBalance: {
      update: vi.fn(),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },

    inventoryReservation: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },

    inventoryMovement: {
      create: vi.fn(),
      findMany: vi.fn(),
    },

    order: {
      findFirst: vi.fn(),
    },

    orderItem: {
      update: vi.fn(),
    },

    $transaction: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    const allocationService =
      {} as AllocationService;

    service = new InventoryService(
      prisma as any,
      allocationService,
    );
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('lists tenant inventory with search, pagination, and store-specific references', async () => {
    const items = [{ id: 'inventory-1', sku: 'SKU-1', balances: [] }];
    prisma.$transaction.mockResolvedValue([items, 1]);

    const result = await service.listItems({
      tenantId: 'tenant-1',
      storeId: 'store-1',
      query: 'snowboard',
      page: 2,
      limit: 25,
    });

    expect(prisma.inventoryItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-1',
          active: true,
          OR: [
            { sku: { contains: 'snowboard', mode: 'insensitive' } },
            { name: { contains: 'snowboard', mode: 'insensitive' } },
          ],
        }),
        skip: 25,
        take: 25,
        include: expect.objectContaining({
          externalReferences: { where: { storeId: 'store-1' } },
        }),
      }),
    );
    expect(result).toEqual({
      items,
      total: 1,
      page: 2,
      limit: 25,
      totalPages: 1,
    });
  });

});
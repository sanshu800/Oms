import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { InventoryService } from './inventory.service';
import { AllocationService } from './allocation.service';

describe('InventoryService', () => {
  let service: InventoryService;

  const prisma = {
    inventoryItem: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
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
});
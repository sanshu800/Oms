import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  FulfillmentStatus,
  InventoryReservationStatus,
  ShipmentStatus,
} from '@prisma/client';

import { FulfillmentService } from './fulfillment.service';

describe('FulfillmentService', () => {
  let service: FulfillmentService;

  const prisma = {
    order: {
      findFirst: vi.fn(),
    },

    fulfillment: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },

    shipment: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },

    shipmentItem: {
      aggregate: vi.fn(),
      findMany: vi.fn(),
    },

    inventoryReservation: {
      findMany: vi.fn(),
    },

    $transaction: vi.fn(),
  };

  const inventoryService = {
    releaseOrder: vi.fn(),
    commitOrder: vi.fn(),
    shipOrder: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    prisma.$transaction.mockImplementation(
      async (callback: (tx: typeof prisma) => unknown) =>
        callback(prisma),
    );

    service = new FulfillmentService(
      prisma as any,
      inventoryService as any,
    );
  });

  const context = {
    tenantId: 'tenant-1',
    storeId: 'store-1',
  };

  const baseFulfillment = {
    id: 'fulfillment-1',
    tenantId: context.tenantId,
    storeId: context.storeId,
    orderId: 'order-1',
    locationId: 'location-1',
    status: FulfillmentStatus.READY,

    order: {
      id: 'order-1',
    },

    location: {
      id: 'location-1',
    },

    items: [
      {
        id: 'fulfillment-item-1',
        orderItemId: 'order-item-1',
        reservationId: 'reservation-1',
        inventoryItemId: 'inventory-1',
        quantity: 5,

        reservation: {
          id: 'reservation-1',
          quantity: 5,
          status: InventoryReservationStatus.ACTIVE,
        },

        orderItem: {
          id: 'order-item-1',
        },

        inventoryItem: {
          id: 'inventory-1',
        },

        shipmentItems: [],
      },
    ],

    shipments: [],
  };

  describe('create', () => {
    it('should create a fulfillment from active reservations', async () => {
      prisma.order.findFirst.mockResolvedValue({
        id: 'order-1',
        items: [
          {
            id: 'order-item-1',
          },
        ],
        reservations: [
          {
            id: 'reservation-1',
            orderItemId: 'order-item-1',
            inventoryItemId: 'inventory-1',
            quantity: 5,
            locationId: 'location-1',
            status: InventoryReservationStatus.ACTIVE,
          },
        ],
      });

      prisma.fulfillment.findFirst.mockResolvedValue(null);

      prisma.fulfillment.create.mockResolvedValue({
        ...baseFulfillment,
      });

      const result = await service.create({
        ...context,
        orderId: 'order-1',
        locationId: 'location-1',
      });

      expect(result.id).toBe('fulfillment-1');

      expect(prisma.fulfillment.create).toHaveBeenCalledTimes(1);

      expect(prisma.fulfillment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: context.tenantId,
            storeId: context.storeId,
            orderId: 'order-1',
            locationId: 'location-1',
            status: FulfillmentStatus.READY,
          }),
        }),
      );
    });

    it('should reject creation when no active reservation exists', async () => {
      prisma.order.findFirst.mockResolvedValue({
        id: 'order-1',
        items: [],
        reservations: [],
      });

      await expect(
        service.create({
          ...context,
          orderId: 'order-1',
          locationId: 'location-1',
        }),
      ).rejects.toThrow(
        'No active inventory reservations found',
      );

      expect(prisma.fulfillment.create).not.toHaveBeenCalled();
    });

    it('should return an existing non-cancelled fulfillment', async () => {
      prisma.order.findFirst.mockResolvedValue({
        id: 'order-1',
        items: [],
        reservations: [
          {
            id: 'reservation-1',
            orderItemId: 'order-item-1',
            inventoryItemId: 'inventory-1',
            quantity: 5,
            locationId: 'location-1',
            status: InventoryReservationStatus.ACTIVE,
          },
        ],
      });

      prisma.fulfillment.findFirst.mockResolvedValue(
        baseFulfillment,
      );

      const result = await service.create({
        ...context,
        orderId: 'order-1',
        locationId: 'location-1',
      });

      expect(result).toBe(baseFulfillment);
      expect(prisma.fulfillment.create).not.toHaveBeenCalled();
    });
  });

  describe('createForOrder', () => {
    it('should create one fulfillment per reserved inventory location', async () => {
      prisma.inventoryReservation.findMany.mockResolvedValue([
        { locationId: 'location-1' },
        { locationId: 'location-2' },
      ]);

      const createSpy = vi
        .spyOn(service, 'create')
        .mockResolvedValue(baseFulfillment as any);

      const result = await service.createForOrder({
        ...context,
        orderId: 'order-1',
      });

      expect(result).toHaveLength(2);

      expect(createSpy).toHaveBeenCalledTimes(2);

      expect(createSpy).toHaveBeenNthCalledWith(1, {
        ...context,
        orderId: 'order-1',
        locationId: 'location-1',
      });

      expect(createSpy).toHaveBeenNthCalledWith(2, {
        ...context,
        orderId: 'order-1',
        locationId: 'location-2',
      });
    });
  });

  describe('start', () => {
    it('should move a READY fulfillment to IN_PROGRESS', async () => {
      prisma.fulfillment.findFirst.mockResolvedValue(
        baseFulfillment,
      );

      prisma.fulfillment.update.mockResolvedValue({
        ...baseFulfillment,
        status: FulfillmentStatus.IN_PROGRESS,
      });

      const result = await service.start({
        ...context,
        fulfillmentId: 'fulfillment-1',
      });

      expect(result.status).toBe(
        FulfillmentStatus.IN_PROGRESS,
      );

      expect(prisma.fulfillment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: 'fulfillment-1',
          },
          data: {
            status: FulfillmentStatus.IN_PROGRESS,
          },
        }),
      );
    });

    it('should reject starting a fulfillment that is not READY', async () => {
      prisma.fulfillment.findFirst.mockResolvedValue({
        ...baseFulfillment,
        status: FulfillmentStatus.FULFILLED,
      });

      await expect(
        service.start({
          ...context,
          fulfillmentId: 'fulfillment-1',
        }),
      ).rejects.toThrow(
        'Cannot start fulfillment from status FULFILLED',
      );

      expect(prisma.fulfillment.update).not.toHaveBeenCalled();
    });
  });

  describe('cancel', () => {
    it('should release inventory and cancel the fulfillment', async () => {
      prisma.fulfillment.findFirst.mockResolvedValue(
        baseFulfillment,
      );

      inventoryService.releaseOrder.mockResolvedValue({
        released: true,
        reservationCount: 1,
      });

      prisma.fulfillment.update.mockResolvedValue({
        ...baseFulfillment,
        status: FulfillmentStatus.CANCELLED,
      });

      const result = await service.cancel({
        ...context,
        fulfillmentId: 'fulfillment-1',
      });

      expect(
        inventoryService.releaseOrder,
      ).toHaveBeenCalledWith({
        tenantId: context.tenantId,
        storeId: context.storeId,
        orderId: 'order-1',
      });

      expect(result.status).toBe(
        FulfillmentStatus.CANCELLED,
      );
    });
  });

  describe('createShipment', () => {
    it('should create a shipment for a valid fulfillment quantity', async () => {
      prisma.fulfillment.findFirst.mockResolvedValue({
        ...baseFulfillment,
        status: FulfillmentStatus.IN_PROGRESS,
      });

      prisma.shipmentItem.aggregate.mockResolvedValue({
        _sum: {
          quantity: 0,
        },
      });

      prisma.shipment.findFirst.mockResolvedValue(null);

      prisma.shipment.create.mockResolvedValue({
        id: 'shipment-1',
        fulfillmentId: 'fulfillment-1',
        status: ShipmentStatus.CREATED,
        items: [
          {
            fulfillmentItemId: 'fulfillment-item-1',
            orderItemId: 'order-item-1',
            quantity: 5,
          },
        ],
      });

      const result = await service.createShipment({
        ...context,
        fulfillmentId: 'fulfillment-1',
        externalShipmentId: 'EXT-SHIP-1',
        carrier: 'UPS',
        service: 'GROUND',
        trackingNumber: 'TRACK-1',
        items: [
          {
            fulfillmentItemId: 'fulfillment-item-1',
            quantity: 5,
          },
        ],
      });

      expect(result.id).toBe('shipment-1');

      expect(prisma.shipment.create).toHaveBeenCalledTimes(1);
    });

    it('should reject shipment quantity exceeding remaining fulfillment quantity', async () => {
      prisma.fulfillment.findFirst.mockResolvedValue({
        ...baseFulfillment,
        status: FulfillmentStatus.IN_PROGRESS,
      });

      prisma.shipmentItem.aggregate.mockResolvedValue({
        _sum: {
          quantity: 4,
        },
      });

      await expect(
        service.createShipment({
          ...context,
          fulfillmentId: 'fulfillment-1',
          items: [
            {
              fulfillmentItemId: 'fulfillment-item-1',
              quantity: 2,
            },
          ],
        }),
      ).rejects.toThrow(
        'Shipment quantity exceeds remaining fulfillment quantity',
      );

      expect(prisma.shipment.create).not.toHaveBeenCalled();
    });
  });

  describe('shipShipment', () => {
    it('should ship the shipment and transition inventory', async () => {
      prisma.shipment.findFirst.mockResolvedValue({
        id: 'shipment-1',
        tenantId: context.tenantId,
        storeId: context.storeId,
        status: ShipmentStatus.CREATED,
        fulfillment: {
          orderId: 'order-1',
        },
        items: [],
      });

      inventoryService.shipOrder.mockResolvedValue({
        shipped: true,
        reservationCount: 1,
      });

      prisma.shipment.update.mockResolvedValue({
        id: 'shipment-1',
        status: ShipmentStatus.IN_TRANSIT,
        items: [],
      });

      const result = await service.shipShipment({
        ...context,
        shipmentId: 'shipment-1',
      });

      expect(
        inventoryService.shipOrder,
      ).toHaveBeenCalledWith({
        tenantId: context.tenantId,
        storeId: context.storeId,
        orderId: 'order-1',
      });

      expect(result.status).toBe(
        ShipmentStatus.IN_TRANSIT,
      );
    });
  });

  describe('fail', () => {
    it('releases reservations and marks the fulfillment FAILED', async () => {
      prisma.fulfillment.findFirst.mockResolvedValue({
        id: 'fulfillment-1',
        tenantId: context.tenantId,
        storeId: context.storeId,
        orderId: 'order-1',
        status: FulfillmentStatus.IN_PROGRESS,
        items: [],
        shipments: [],
      });

      prisma.fulfillment.update.mockResolvedValue({
        id: 'fulfillment-1',
        status: FulfillmentStatus.FAILED,
        items: [],
        shipments: [],
      });

      const result = await service.fail({
        ...context,
        fulfillmentId: 'fulfillment-1',
      });

      expect(inventoryService.releaseOrder).toHaveBeenCalledWith({
        tenantId: context.tenantId,
        storeId: context.storeId,
        orderId: 'order-1',
      });

      expect(result.status).toBe(FulfillmentStatus.FAILED);
    });

    it('is idempotent on an already-failed fulfillment', async () => {
      prisma.fulfillment.findFirst.mockResolvedValue({
        id: 'fulfillment-1',
        tenantId: context.tenantId,
        storeId: context.storeId,
        orderId: 'order-1',
        status: FulfillmentStatus.FAILED,
        items: [],
        shipments: [],
      });

      const result = await service.fail({
        ...context,
        fulfillmentId: 'fulfillment-1',
      });

      expect(result.status).toBe(FulfillmentStatus.FAILED);
      expect(prisma.fulfillment.update).not.toHaveBeenCalled();
    });

    it('refuses to fail a fulfillment that already shipped something', async () => {
      prisma.fulfillment.findFirst.mockResolvedValue({
        id: 'fulfillment-1',
        tenantId: context.tenantId,
        storeId: context.storeId,
        orderId: 'order-1',
        status: FulfillmentStatus.PARTIALLY_FULFILLED,
        items: [],
        shipments: [],
      });

      await expect(
        service.fail({
          ...context,
          fulfillmentId: 'fulfillment-1',
        }),
      ).rejects.toThrow(
        'Cannot fail fulfillment from status PARTIALLY_FULFILLED',
      );

      expect(inventoryService.releaseOrder).not.toHaveBeenCalled();
    });
  });
});
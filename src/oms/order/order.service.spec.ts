import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { OrderService } from './order.service';

describe('OrderService', () => {
  let service: OrderService;

  const prisma = {
    order: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
  };

  const inventoryService = {
    reserveOrder: vi.fn(),
    releaseOrder: vi.fn(),
    commitOrder: vi.fn(),
    shipOrder: vi.fn(),
  };

  const orderFailureExceptionService = {
    detectAndRaise: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    inventoryService.reserveOrder.mockResolvedValue({
      reserved: false,
      reason: 'NO_LINE_ITEMS',
    });

    service = new OrderService(
      prisma as any,
      inventoryService as any,
      orderFailureExceptionService as any,
    );
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should create an OMS order from a valid Shopify payload', async () => {
    prisma.order.findUnique.mockResolvedValue(null);

    prisma.order.create.mockResolvedValue({
      id: 'oms-order-001',
      externalOrderId: '123456789',
      orderNumber: '#1001',
      status: 'NEW',
      paymentStatus: 'paid',
      fulfillmentStatus: 'unfulfilled',
      totalAmount: '1499.00',
      currency: 'INR',
      items: [],
    });

    prisma.order.findUniqueOrThrow.mockResolvedValue({
      id: 'oms-order-001',
      externalOrderId: '123456789',
      orderNumber: '#1001',
      status: 'NEW',
      paymentStatus: 'paid',
      fulfillmentStatus: 'unfulfilled',
      totalAmount: '1499.00',
      currency: 'INR',
      items: [],
    });

    const result =
      await service.upsertFromShopify({
        tenantId: 'tenant-001',
        storeId: 'store-001',
        payload: {
          id: 123456789,
          name: '#1001',
          financial_status: 'paid',
          fulfillment_status: null,
          total_price: '1499.00',
          currency: 'INR',
          created_at: '2026-08-14T12:00:00Z',
        },
      });

    expect(prisma.order.create).toHaveBeenCalledTimes(1);

    expect(
      inventoryService.reserveOrder,
    ).toHaveBeenCalledTimes(1);

    expect(result.externalOrderId).toBe(
      '123456789',
    );

    expect(result.orderNumber).toBe('#1001');
  });

  it('should persist an operational exception when inventory reservation fails', async () => {
    const reservationError = new Error(
      'Insufficient inventory for SKU sku-managed-1: requested 58, available 57',
    );

    prisma.order.findUnique.mockResolvedValue(null);

    prisma.order.create.mockResolvedValue({
      id: 'oms-order-failure-001',
      externalOrderId: '123456790',
      orderNumber: '#1002',
      status: 'NEW',
      paymentStatus: 'paid',
      fulfillmentStatus: 'unfulfilled',
      totalAmount: '1259.90',
      currency: 'USD',
      items: [
        {
          id: 'order-item-failure-001',
          sku: 'sku-managed-1',
          title: 'The Multi-managed Snowboard',
          quantity: 58,
        },
      ],
    });

    inventoryService.reserveOrder.mockRejectedValue(reservationError);

    orderFailureExceptionService.detectAndRaise.mockResolvedValue({
      detection: {
        status: 'INSUFFICIENT_INVENTORY',
        detected: true,
      },
      exception: {
        id: 'exception-failure-001',
      },
    });

    await expect(
      service.upsertFromShopify({
        tenantId: 'tenant-001',
        storeId: 'store-001',
        payload: {
          id: 123456790,
          name: '#1002',
          financial_status: 'paid',
          fulfillment_status: null,
          total_price: '1259.90',
          currency: 'USD',
          created_at: '2026-08-21T12:00:00Z',
          line_items: [
            {
              id: 999001,
              sku: 'sku-managed-1',
              title: 'The Multi-managed Snowboard',
              quantity: 58,
              price: '629.95',
            },
          ],
        },
      }),
    ).rejects.toThrow(
      'Insufficient inventory for SKU sku-managed-1',
    );

    expect(
      orderFailureExceptionService.detectAndRaise,
    ).toHaveBeenCalledWith({
      tenantId: 'tenant-001',
      storeId: 'store-001',
      orderId: 'oms-order-failure-001',
      orderNumber: '#1002',
      orderItemId: 'order-item-failure-001',
      sku: 'sku-managed-1',
      requestedQty: 58,
    });

    expect(prisma.order.update).toHaveBeenCalledWith({
      where: {
        id: 'oms-order-failure-001',
      },
      data: {
        status: 'FAILED',
      },
    });
  });
});



import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

vi.mock('@prisma/client', () => import('../../../test-utils/prisma-client.mock'));

import { ShopifyConnector } from '../../connectors/shopify/shopify.connector';
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
    orderItem: {
      create: vi.fn(),
      update: vi.fn(),
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

  // The payloads below are Shopify webhook payloads; since the connector
  // refactor they enter OrderService as NormalizedOrder via
  // ShopifyConnector.normalizeOrder (assertions unchanged).
  async function ingest(input: { payload: unknown; topic?: string }) {
    const connector = new ShopifyConnector({} as never, {} as never);
    const order = connector.normalizeOrder({
      topic: input.topic ?? 'orders/create',
      payload: input.payload,
    });

    return service.upsertFromChannel({
      tenantId: 'tenant-001',
      storeId: 'store-001',
      order,
    });
  }

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
      await ingest({
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
      ingest({
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

  it('reconciles changed Shopify line items and re-reserves the order', async () => {
    prisma.order.findUnique.mockResolvedValue({
      id: 'oms-order-update-001',
      externalOrderId: '123456791',
      orderNumber: '#1003',
      status: 'NEW',
      paymentStatus: 'paid',
      fulfillmentStatus: 'unfulfilled',
      totalAmount: '10.00',
      currency: 'USD',
      orderedAt: new Date('2026-08-22T12:00:00Z'),
      items: [
        {
          id: 'order-item-update-001',
          externalLineItemId: 'line-1',
          sku: 'sku-old',
          title: 'Product',
          quantity: 1,
          unitPrice: '10.00',
        },
      ],
      reservations: [{ status: 'ACTIVE' }],
    });
    prisma.order.update.mockResolvedValue({});
    prisma.orderItem.update.mockResolvedValue({});
    prisma.order.findUniqueOrThrow.mockResolvedValue({
      id: 'oms-order-update-001',
      orderNumber: '#1003',
      items: [],
    });

    const result = await ingest({
      topic: 'orders/updated',
      payload: {
        id: 123456791,
        name: '#1003',
        financial_status: 'paid',
        fulfillment_status: null,
        total_price: '20.00',
        currency: 'USD',
        created_at: '2026-08-22T12:00:00Z',
        line_items: [
          {
            id: 'line-1',
            sku: 'sku-new',
            title: 'Product updated',
            quantity: 2,
            price: '10.00',
          },
        ],
      },
    });

    expect(inventoryService.releaseOrder).toHaveBeenCalledWith({
      tenantId: 'tenant-001',
      storeId: 'store-001',
      orderId: 'oms-order-update-001',
    });
    expect(prisma.orderItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'order-item-update-001' },
        data: expect.objectContaining({
          sku: 'sku-new',
          quantity: 2,
          inventoryItemId: null,
        }),
      }),
    );
    expect(inventoryService.reserveOrder).toHaveBeenCalledWith({
      tenantId: 'tenant-001',
      storeId: 'store-001',
      orderId: 'oms-order-update-001',
    });
    expect(result.id).toBe('oms-order-update-001');
  });

  it('cancels an existing Shopify order and releases its active stock reservation', async () => {
    prisma.order.findUnique.mockResolvedValue({
      id: 'oms-order-cancel-001',
      externalOrderId: '123456792',
      orderNumber: '#1004',
      status: 'NEW',
      paymentStatus: 'paid',
      fulfillmentStatus: 'unfulfilled',
      items: [],
      reservations: [{ status: 'ACTIVE' }],
    });
    prisma.order.update.mockResolvedValue({});
    prisma.order.findUniqueOrThrow.mockResolvedValue({
      id: 'oms-order-cancel-001',
      status: 'CANCELLED',
      items: [],
    });

    const result = await ingest({
      topic: 'orders/cancelled',
      payload: {
        id: 123456792,
        name: '#1004',
        financial_status: 'refunded',
        fulfillment_status: null,
        total_price: '0.00',
        currency: 'USD',
        created_at: '2026-08-23T12:00:00Z',
        cancelled_at: '2026-08-23T13:00:00Z',
      },
    });

    expect(inventoryService.releaseOrder).toHaveBeenCalledWith({
      tenantId: 'tenant-001',
      storeId: 'store-001',
      orderId: 'oms-order-cancel-001',
    });
    expect(prisma.order.update).toHaveBeenLastCalledWith({
      where: { id: 'oms-order-cancel-001' },
      data: { status: 'CANCELLED' },
    });
    expect(inventoryService.reserveOrder).not.toHaveBeenCalled();
    expect(result.status).toBe('CANCELLED');
  });

  it('does not change committed SKU or quantity when Shopify updates a fulfilled order', async () => {
    prisma.order.findUnique.mockResolvedValue({
      id: 'oms-order-fulfilled-001',
      externalOrderId: '123456793',
      orderNumber: '#1005',
      status: 'FULFILLED',
      paymentStatus: 'paid',
      fulfillmentStatus: 'fulfilled',
      items: [
        {
          id: 'order-item-fulfilled-001',
          externalLineItemId: 'line-1',
          sku: 'sku-original',
          title: 'Product',
          quantity: 1,
          unitPrice: '10.00',
        },
      ],
      reservations: [{ status: 'SHIPPED' }],
    });
    prisma.order.update.mockResolvedValue({});
    prisma.orderItem.update.mockResolvedValue({});
    prisma.order.findUniqueOrThrow.mockResolvedValue({
      id: 'oms-order-fulfilled-001',
      items: [],
    });

    await ingest({
      topic: 'orders/updated',
      payload: {
        id: 123456793,
        name: '#1005',
        financial_status: 'paid',
        fulfillment_status: 'fulfilled',
        total_price: '20.00',
        currency: 'USD',
        created_at: '2026-08-24T12:00:00Z',
        line_items: [
          {
            id: 'line-1',
            sku: 'sku-changed',
            title: 'Product description changed',
            quantity: 2,
            price: '10.00',
          },
        ],
      },
    });

    expect(prisma.orderItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'order-item-fulfilled-001' },
        data: expect.not.objectContaining({
          sku: expect.anything(),
          quantity: expect.anything(),
        }),
      }),
    );
    expect(inventoryService.releaseOrder).not.toHaveBeenCalled();
    expect(inventoryService.reserveOrder).not.toHaveBeenCalled();
  });


  it('retries an order allocation when a replay still has uncovered quantity', async () => {
    prisma.order.findUnique.mockResolvedValue({
      id: 'oms-order-retry-001',
      externalOrderId: '123456794',
      orderNumber: '#1006',
      status: 'FAILED',
      paymentStatus: 'paid',
      fulfillmentStatus: 'unfulfilled',
      items: [
        {
          id: 'order-item-retry-001',
          externalLineItemId: 'line-1',
          sku: 'sku-managed-1',
          title: 'Product',
          quantity: 2,
          unitPrice: '5.00',
        },
      ],
      reservations: [],
    });
    prisma.order.update.mockResolvedValue({});
    prisma.orderItem.update.mockResolvedValue({});
    prisma.order.findUniqueOrThrow.mockResolvedValue({
      id: 'oms-order-retry-001',
      orderNumber: '#1006',
      items: [
        {
          id: 'order-item-retry-001',
          sku: 'sku-managed-1',
          quantity: 2,
        },
      ],
    });

    await ingest({
      topic: 'orders/updated',
      payload: {
        id: 123456794,
        name: '#1006',
        financial_status: 'paid',
        fulfillment_status: null,
        total_price: '10.00',
        currency: 'USD',
        created_at: '2026-08-25T12:00:00Z',
        line_items: [
          {
            id: 'line-1',
            sku: 'sku-managed-1',
            title: 'Product',
            quantity: 2,
            price: '5.00',
          },
        ],
      },
    });

    expect(inventoryService.reserveOrder).toHaveBeenCalledWith({
      tenantId: 'tenant-001',
      storeId: 'store-001',
      orderId: 'oms-order-retry-001',
    });
  });


  it('ignores an out-of-order Shopify update after cancellation', async () => {
    prisma.order.findUnique.mockResolvedValue({
      id: 'oms-order-cancelled-terminal',
      externalOrderId: '123456795',
      orderNumber: '#1007',
      status: 'CANCELLED',
      items: [],
      reservations: [],
    });
    prisma.order.findUniqueOrThrow.mockResolvedValue({
      id: 'oms-order-cancelled-terminal',
      status: 'CANCELLED',
      items: [],
    });

    await ingest({
      topic: 'orders/updated',
      payload: {
        id: 123456795,
        name: '#1007',
        financial_status: 'paid',
        fulfillment_status: null,
        total_price: '10.00',
        currency: 'USD',
        created_at: '2026-08-26T12:00:00Z',
        line_items: [],
      },
    });

    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(inventoryService.releaseOrder).not.toHaveBeenCalled();
    expect(inventoryService.reserveOrder).not.toHaveBeenCalled();
  });

});



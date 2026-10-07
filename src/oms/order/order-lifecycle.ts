import { OrderStatus } from '@prisma/client';

const allowedTransitions: Record<
  OrderStatus,
  readonly OrderStatus[]
> = {
  NEW: [
    OrderStatus.CONFIRMED,
    OrderStatus.CANCELLED,
    OrderStatus.FAILED,
  ],

  CONFIRMED: [
    OrderStatus.PROCESSING,
    OrderStatus.CANCELLED,
    OrderStatus.FAILED,
  ],

  PROCESSING: [
    OrderStatus.READY_TO_FULFILL,
    OrderStatus.CANCELLED,
    OrderStatus.FAILED,
  ],

  READY_TO_FULFILL: [
    OrderStatus.FULFILLING,
    OrderStatus.CANCELLED,
    OrderStatus.FAILED,
  ],

  FULFILLING: [
    OrderStatus.FULFILLED,
    OrderStatus.FAILED,
  ],

  FULFILLED: [],

  CANCELLED: [],

  FAILED: [],
};

export function canTransitionOrder(
  from: OrderStatus,
  to: OrderStatus,
): boolean {
  return allowedTransitions[from].includes(to);
}

export function assertOrderTransition(
  from: OrderStatus,
  to: OrderStatus,
): void {
  if (!canTransitionOrder(from, to)) {
    throw new Error(
      `Invalid order status transition: ${from} -> ${to}`,
    );
  }
}
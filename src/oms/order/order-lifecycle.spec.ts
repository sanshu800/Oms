import { describe, expect, it } from 'vitest';
import { OrderStatus } from '@prisma/client';
import {
  assertOrderTransition,
  canTransitionOrder,
} from './order-lifecycle';

describe('Order lifecycle policy', () => {
  it('allows the normal order lifecycle', () => {
    expect(
      canTransitionOrder(OrderStatus.NEW, OrderStatus.CONFIRMED),
    ).toBe(true);

    expect(
      canTransitionOrder(
        OrderStatus.CONFIRMED,
        OrderStatus.PROCESSING,
      ),
    ).toBe(true);

    expect(
      canTransitionOrder(
        OrderStatus.PROCESSING,
        OrderStatus.READY_TO_FULFILL,
      ),
    ).toBe(true);

    expect(
      canTransitionOrder(
        OrderStatus.READY_TO_FULFILL,
        OrderStatus.FULFILLING,
      ),
    ).toBe(true);

    expect(
      canTransitionOrder(
        OrderStatus.FULFILLING,
        OrderStatus.FULFILLED,
      ),
    ).toBe(true);
  });

  it('allows cancellation before fulfillment begins', () => {
    expect(
      canTransitionOrder(
        OrderStatus.NEW,
        OrderStatus.CANCELLED,
      ),
    ).toBe(true);

    expect(
      canTransitionOrder(
        OrderStatus.CONFIRMED,
        OrderStatus.CANCELLED,
      ),
    ).toBe(true);

    expect(
      canTransitionOrder(
        OrderStatus.PROCESSING,
        OrderStatus.CANCELLED,
      ),
    ).toBe(true);

    expect(
      canTransitionOrder(
        OrderStatus.READY_TO_FULFILL,
        OrderStatus.CANCELLED,
      ),
    ).toBe(true);
  });

  it('allows failures during active processing', () => {
    expect(
      canTransitionOrder(
        OrderStatus.NEW,
        OrderStatus.FAILED,
      ),
    ).toBe(true);

    expect(
      canTransitionOrder(
        OrderStatus.PROCESSING,
        OrderStatus.FAILED,
      ),
    ).toBe(true);

    expect(
      canTransitionOrder(
        OrderStatus.FULFILLING,
        OrderStatus.FAILED,
      ),
    ).toBe(true);
  });

  it('rejects backward transitions', () => {
    expect(
      canTransitionOrder(
        OrderStatus.PROCESSING,
        OrderStatus.NEW,
      ),
    ).toBe(false);

    expect(
      canTransitionOrder(
        OrderStatus.FULFILLING,
        OrderStatus.PROCESSING,
      ),
    ).toBe(false);
  });

  it('rejects transitions from terminal states', () => {
    expect(
      canTransitionOrder(
        OrderStatus.FULFILLED,
        OrderStatus.CANCELLED,
      ),
    ).toBe(false);

    expect(
      canTransitionOrder(
        OrderStatus.CANCELLED,
        OrderStatus.PROCESSING,
      ),
    ).toBe(false);

    expect(
      canTransitionOrder(
        OrderStatus.FAILED,
        OrderStatus.CONFIRMED,
      ),
    ).toBe(false);
  });

  it('throws when an invalid transition is asserted', () => {
    expect(() =>
      assertOrderTransition(
        OrderStatus.FULFILLED,
        OrderStatus.CANCELLED,
      ),
    ).toThrow(
      'Invalid order status transition: FULFILLED -> CANCELLED',
    );
  });
});
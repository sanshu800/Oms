export class OrderBusinessFailureError extends Error {
  readonly code = "ORDER_BUSINESS_FAILURE";

  constructor(
    message: string,
    readonly exceptionId: string,
    readonly orderId: string,
  ) {
    super(message);
    this.name = "OrderBusinessFailureError";
  }
}


import { FulfillmentStatus, ShipmentStatus } from "@prisma/client";

export type FulfillmentContext = {
  tenantId: string;
  storeId: string;
};

export type CreateFulfillmentInput = FulfillmentContext & {
  orderId: string;
  locationId: string;
};

export type StartFulfillmentInput = FulfillmentContext & {
  fulfillmentId: string;
};

export type CancelFulfillmentInput = FulfillmentContext & {
  fulfillmentId: string;
};

export type CompleteFulfillmentInput = FulfillmentContext & {
  fulfillmentId: string;
};

export type CreateShipmentInput = FulfillmentContext & {
  fulfillmentId: string;
  externalShipmentId?: string;
  carrier?: string;
  service?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  items: Array<{
    fulfillmentItemId: string;
    quantity: number;
  }>;
};

export type LabelShipmentInput = FulfillmentContext & {
  shipmentId: string;
};

export type ShipShipmentInput = FulfillmentContext & {
  shipmentId: string;
};

export type DeliverShipmentInput = FulfillmentContext & {
  shipmentId: string;
};

export type CancelShipmentInput = FulfillmentContext & {
  shipmentId: string;
};

export type FulfillmentWithRelations = {
  id: string;
  tenantId: string;
  storeId: string;
  orderId: string;
  locationId: string;
  status: FulfillmentStatus;
};

export type ShipmentWithRelations = {
  id: string;
  tenantId: string;
  storeId: string;
  fulfillmentId: string;
  status: ShipmentStatus;
};

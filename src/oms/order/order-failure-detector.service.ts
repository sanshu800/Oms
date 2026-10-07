import { Injectable } from "@nestjs/common";

import {
  InventoryTruth,
  InventoryTruthService,
} from "../inventory/inventory-truth.service";

export type OrderFailureDetectionStatus =
  | "FULFILLABLE"
  | "INSUFFICIENT_INVENTORY"
  | "ZERO_AVAILABILITY"
  | "UNKNOWN_SKU"
  | "STALE_INVENTORY";

export type OrderFailureDetectionInput = {
  tenantId: string;
  orderId: string;
  orderNumber?: string;
  orderItemId?: string;
  sku: string;
  requestedQty: number;
  maxInventoryAgeMinutes?: number;
};

export type OrderFailureDetectionResult = {
  status: OrderFailureDetectionStatus;
  detected: boolean;
  orderId: string;
  orderNumber?: string;
  orderItemId?: string;
  sku: string;
  requestedQty: number;
  availableQty: number | null;
  shortageQty: number;
  inventoryItemId: string | null;
  inventoryTruth: InventoryTruth | null;
  reason: string;
};

@Injectable()
export class OrderFailureDetectorService {
  constructor(
    private readonly inventoryTruthService: InventoryTruthService,
  ) {}

  async detect(
    input: OrderFailureDetectionInput,
  ): Promise<OrderFailureDetectionResult> {
    const sku = input.sku.trim();

    if (!sku) {
      throw new Error("sku is required");
    }

    if (
      !Number.isInteger(input.requestedQty) ||
      input.requestedQty <= 0
    ) {
      throw new Error("requestedQty must be a positive integer");
    }

    const truth =
      await this.inventoryTruthService.getSkuTruth({
        tenantId: input.tenantId,
        sku,
        maxAgeMinutes: input.maxInventoryAgeMinutes,
      });

    if (!truth) {
      return {
        status: "UNKNOWN_SKU",
        detected: true,
        orderId: input.orderId,
        orderNumber: input.orderNumber,
        orderItemId: input.orderItemId,
        sku,
        requestedQty: input.requestedQty,
        availableQty: null,
        shortageQty: input.requestedQty,
        inventoryItemId: null,
        inventoryTruth: null,
        reason:
          "No canonical inventory item exists for this SKU.",
      };
    }

    if (truth.isStale) {
      return {
        status: "STALE_INVENTORY",
        detected: true,
        orderId: input.orderId,
        orderNumber: input.orderNumber,
        orderItemId: input.orderItemId,
        sku,
        requestedQty: input.requestedQty,
        availableQty: truth.availableQty,
        shortageQty: Math.max(
          input.requestedQty - truth.availableQty,
          0,
        ),
        inventoryItemId: truth.inventoryItemId,
        inventoryTruth: truth,
        reason:
          "Inventory truth is stale and should not be trusted for an automated fulfillment decision.",
      };
    }

    if (truth.availableQty === 0) {
      return {
        status: "ZERO_AVAILABILITY",
        detected: true,
        orderId: input.orderId,
        orderNumber: input.orderNumber,
        orderItemId: input.orderItemId,
        sku,
        requestedQty: input.requestedQty,
        availableQty: 0,
        shortageQty: input.requestedQty,
        inventoryItemId: truth.inventoryItemId,
        inventoryTruth: truth,
        reason:
          "The SKU has zero currently available inventory.",
      };
    }

    if (input.requestedQty > truth.availableQty) {
      return {
        status: "INSUFFICIENT_INVENTORY",
        detected: true,
        orderId: input.orderId,
        orderNumber: input.orderNumber,
        orderItemId: input.orderItemId,
        sku,
        requestedQty: input.requestedQty,
        availableQty: truth.availableQty,
        shortageQty:
          input.requestedQty - truth.availableQty,
        inventoryItemId: truth.inventoryItemId,
        inventoryTruth: truth,
        reason:
          "Requested quantity exceeds currently available inventory.",
      };
    }

    return {
      status: "FULFILLABLE",
      detected: false,
      orderId: input.orderId,
      orderNumber: input.orderNumber,
      orderItemId: input.orderItemId,
      sku,
      requestedQty: input.requestedQty,
      availableQty: truth.availableQty,
      shortageQty: 0,
      inventoryItemId: truth.inventoryItemId,
      inventoryTruth: truth,
      reason:
        "Requested quantity can be fulfilled from current available inventory.",
    };
  }
}

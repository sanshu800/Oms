import { Injectable } from "@nestjs/common";
import { ExceptionSeverity } from "@prisma/client";

import {
  OrderFailureDetectionInput,
  OrderFailureDetectionResult,
  OrderFailureDetectorService,
} from "./order-failure-detector.service";

import { ExceptionService } from "../exception/exception.service";

@Injectable()
export class OrderFailureExceptionService {
  constructor(
    private readonly detector: OrderFailureDetectorService,
    private readonly exceptionService: ExceptionService,
  ) {}

  async detectAndRaise(
    input: OrderFailureDetectionInput & {
      storeId: string;
    },
  ): Promise<{
    detection: OrderFailureDetectionResult;
    exception: { id: string } | null;
  }> {
    const detection = await this.detector.detect(input);

    if (!detection.detected) {
      return {
        detection,
        exception: null,
      };
    }

    const fingerprint =
      `ORDER_INVENTORY_FAILURE:${input.orderId}:` +
      `${input.orderItemId ?? input.sku}`;

    const exception =
      await this.exceptionService.createOrUpdateException({
        tenantId: input.tenantId,
        storeId: input.storeId,
        fingerprint,
        category: "ORDER_OPERATIONAL_RISK",
        severity: ExceptionSeverity.HIGH,
        title: this.buildTitle(detection),
        evidence: {
          detectionStatus: detection.status,
          orderId: detection.orderId,
          orderNumber: detection.orderNumber,
          orderItemId: detection.orderItemId,
          sku: detection.sku,
          requestedQty: detection.requestedQty,
          availableQty: detection.availableQty,
          shortageQty: detection.shortageQty,
          inventoryItemId: detection.inventoryItemId,
          locationCount:
            detection.inventoryTruth?.locationCount ?? null,
          isStale:
            detection.inventoryTruth?.isStale ?? null,
        },
        recommendedNextStep:
          this.buildRecommendedNextStep(detection),
      });

    return {
      detection,
      exception,
    };
  }

  private buildTitle(
    detection: OrderFailureDetectionResult,
  ): string {
    switch (detection.status) {
      case "INSUFFICIENT_INVENTORY":
        return `Order ${detection.orderNumber ?? detection.orderId} has insufficient inventory for ${detection.sku}`;

      case "ZERO_AVAILABILITY":
        return `Order ${detection.orderNumber ?? detection.orderId} has zero available inventory for ${detection.sku}`;

      case "UNKNOWN_SKU":
        return `Order ${detection.orderNumber ?? detection.orderId} references unknown SKU ${detection.sku}`;

      case "STALE_INVENTORY":
        return `Order ${detection.orderNumber ?? detection.orderId} depends on stale inventory for ${detection.sku}`;

      default:
        return `Order ${detection.orderNumber ?? detection.orderId} requires operational attention`;
    }
  }

  private buildRecommendedNextStep(
    detection: OrderFailureDetectionResult,
  ): string {
    switch (detection.status) {
      case "INSUFFICIENT_INVENTORY":
        return "Review available inventory across locations and determine the appropriate fulfillment or recovery action.";

      case "ZERO_AVAILABILITY":
        return "Review inventory availability and determine the appropriate fulfillment or recovery action.";

      case "UNKNOWN_SKU":
        return "Verify the order SKU mapping and canonical inventory item before attempting fulfillment.";

      case "STALE_INVENTORY":
        return "Refresh inventory data and verify current availability before making an automated fulfillment decision.";

      default:
        return "Investigate the order and inventory state.";
    }
  }
}

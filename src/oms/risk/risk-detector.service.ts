import { Injectable } from "@nestjs/common";
import {
  ExceptionSeverity,
  ExceptionStatus,
  FulfillmentStatus,
  InventoryReservationStatus,
  OrderStatus,
  Prisma,
  ShipmentStatus,
} from "@prisma/client";

import { PrismaService } from "../../prisma/prisma.service";
import { ExceptionService } from "../exception/exception.service";

export type RiskDetectionContext = {
  tenantId: string;
  storeId: string;
};

@Injectable()
export class RiskDetectorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly exceptionService: ExceptionService,
  ) {}

  async detect(input: RiskDetectionContext) {
    const results = [];

    results.push(...(await this.detectInventoryRisks(input)));
    results.push(...(await this.detectReservationRisks(input)));
    results.push(...(await this.detectFulfillmentRisks(input)));
    results.push(...(await this.detectShipmentRisks(input)));
    results.push(...(await this.detectOrderRisks(input)));

    return {
      detected: results.length,
      exceptions: results,
    };
  }

  // ============================================================
  // INVENTORY RISKS
  // ============================================================

  private async detectInventoryRisks(input: RiskDetectionContext) {
    const balances = await this.prisma.inventoryBalance.findMany({
      where: {
        inventoryItem: {
          tenantId: input.tenantId,
        },
      },
      include: {
        inventoryItem: true,
        location: true,
      },
    });

    const results = [];

    for (const balance of balances) {
      const available = balance.availableQty;
      const reserved = balance.reservedQty;
      const committed = balance.committedQty;

      if (available < 0 || reserved < 0 || committed < 0) {
        results.push(
          await this.raise(input, {
            fingerprint: `inventory-negative:${balance.inventoryItemId}:${balance.locationId}`,
            category: "INVENTORY_INTEGRITY",
            severity: ExceptionSeverity.CRITICAL,
            title: `Negative inventory detected for ${balance.inventoryItem.sku}`,
            evidence: {
              inventoryItemId: balance.inventoryItemId,
              sku: balance.inventoryItem.sku,
              locationId: balance.locationId,
              availableQty: available,
              reservedQty: reserved,
              committedQty: committed,
            },
            recommendedNextStep:
              "Inspect inventory movements and reconcile the affected location before further fulfillment.",
          }),
        );
      }
    }

    return results;
  }

  // ============================================================
  // RESERVATION RISKS
  // ============================================================

  private async detectReservationRisks(input: RiskDetectionContext) {
    const reservations = await this.prisma.inventoryReservation.findMany({
      where: {
        tenantId: input.tenantId,
        storeId: input.storeId,
        status: InventoryReservationStatus.ACTIVE,
      },
      include: {
        order: true,
        orderItem: true,
        inventoryItem: true,
        location: true,
      },
    });

    const results = [];

    for (const reservation of reservations) {
      if (reservation.quantity <= 0) {
        results.push(
          await this.raise(input, {
            fingerprint: `reservation-invalid:${reservation.id}`,
            category: "RESERVATION_INTEGRITY",
            severity: ExceptionSeverity.HIGH,
            title: `Invalid inventory reservation for ${reservation.inventoryItem.sku}`,
            evidence: {
              reservationId: reservation.id,
              orderId: reservation.orderId,
              orderItemId: reservation.orderItemId,
              sku: reservation.inventoryItem.sku,
              quantity: reservation.quantity,
              locationId: reservation.locationId,
            },
            recommendedNextStep:
              "Inspect the reservation and order line before allowing fulfillment to proceed.",
          }),
        );

        continue;
      }

      const balance = await this.prisma.inventoryBalance.findUnique({
        where: {
          inventoryItemId_locationId: {
            inventoryItemId: reservation.inventoryItemId,
            locationId: reservation.locationId,
          },
        },
      });

      if (!balance) {
        results.push(
          await this.raise(input, {
            fingerprint: `reservation-missing-balance:${reservation.id}`,
            category: "RESERVATION_INTEGRITY",
            severity: ExceptionSeverity.CRITICAL,
            title: `Reservation has no inventory balance`,
            evidence: {
              reservationId: reservation.id,
              orderId: reservation.orderId,
              sku: reservation.inventoryItem.sku,
              locationId: reservation.locationId,
              quantity: reservation.quantity,
            },
            recommendedNextStep:
              "Reconcile the inventory location before continuing fulfillment.",
          }),
        );

        continue;
      }

      if (balance.reservedQty < reservation.quantity) {
        results.push(
          await this.raise(input, {
            fingerprint: `reservation-mismatch:${reservation.id}`,
            category: "RESERVATION_INTEGRITY",
            severity: ExceptionSeverity.HIGH,
            title: `Inventory reservation does not match inventory balance`,
            evidence: {
              reservationId: reservation.id,
              orderId: reservation.orderId,
              sku: reservation.inventoryItem.sku,
              locationId: reservation.locationId,
              reservationQuantity: reservation.quantity,
              balanceReservedQty: balance.reservedQty,
            },
            recommendedNextStep:
              "Reconcile the reservation and inventory balance before fulfillment.",
          }),
        );
      }
    }

    return results;
  }

  // ============================================================
  // FULFILLMENT RISKS
  // ============================================================

  private async detectFulfillmentRisks(input: RiskDetectionContext) {
    const fulfillments = await this.prisma.fulfillment.findMany({
      where: {
        tenantId: input.tenantId,
        storeId: input.storeId,
        status: {
          in: [
            FulfillmentStatus.READY,
            FulfillmentStatus.IN_PROGRESS,
            FulfillmentStatus.PARTIALLY_FULFILLED,
          ],
        },
      },
      include: {
        order: true,
        items: true,
        shipments: {
          include: {
            items: true,
          },
        },
      },
    });

    const results = [];

    for (const fulfillment of fulfillments) {
      if (fulfillment.items.length === 0) {
        results.push(
          await this.raise(input, {
            fingerprint: `fulfillment-empty:${fulfillment.id}`,
            category: "FULFILLMENT_INTEGRITY",
            severity: ExceptionSeverity.HIGH,
            title: `Fulfillment has no fulfillment items`,
            evidence: {
              fulfillmentId: fulfillment.id,
              orderId: fulfillment.orderId,
              status: fulfillment.status,
            },
            recommendedNextStep:
              "Inspect order reservations and rebuild the fulfillment allocation.",
          }),
        );
      }

      const shipmentQuantity = fulfillment.shipments
        .filter((shipment) => shipment.status !== ShipmentStatus.CANCELLED)
        .flatMap((shipment) => shipment.items)
        .reduce((sum, item) => sum + item.quantity, 0);

      const fulfillmentQuantity = fulfillment.items.reduce(
        (sum, item) => sum + item.quantity,
        0,
      );

      if (shipmentQuantity > fulfillmentQuantity) {
        results.push(
          await this.raise(input, {
            fingerprint: `fulfillment-over-shipped:${fulfillment.id}`,
            category: "FULFILLMENT_INTEGRITY",
            severity: ExceptionSeverity.CRITICAL,
            title: `Shipment quantity exceeds fulfillment quantity`,
            evidence: {
              fulfillmentId: fulfillment.id,
              orderId: fulfillment.orderId,
              fulfillmentQuantity,
              shipmentQuantity,
            },
            recommendedNextStep:
              "Stop further shipment execution and reconcile fulfillment quantities.",
          }),
        );
      }
    }

    return results;
  }

  // ============================================================
  // SHIPMENT RISKS
  // ============================================================

  private async detectShipmentRisks(input: RiskDetectionContext) {
    const shipments = await this.prisma.shipment.findMany({
      where: {
        tenantId: input.tenantId,
        storeId: input.storeId,
        status: {
          in: [
            ShipmentStatus.CREATED,
            ShipmentStatus.LABEL_CREATED,
            ShipmentStatus.IN_TRANSIT,
            ShipmentStatus.DELIVERED,
          ],
        },
      },
      include: {
        fulfillment: true,
        items: true,
      },
    });

    const results = [];

    for (const shipment of shipments) {
      if (shipment.items.length === 0) {
        results.push(
          await this.raise(input, {
            fingerprint: `shipment-empty:${shipment.id}`,
            category: "SHIPMENT_INTEGRITY",
            severity: ExceptionSeverity.HIGH,
            title: `Shipment has no shipment items`,
            evidence: {
              shipmentId: shipment.id,
              fulfillmentId: shipment.fulfillmentId,
              status: shipment.status,
            },
            recommendedNextStep:
              "Inspect the fulfillment allocation before shipping this shipment.",
          }),
        );
      }

      if (shipment.status === ShipmentStatus.DELIVERED && !shipment.shippedAt) {
        results.push(
          await this.raise(input, {
            fingerprint: `shipment-delivered-without-shipped-at:${shipment.id}`,
            category: "SHIPMENT_INTEGRITY",
            severity: ExceptionSeverity.HIGH,
            title: `Shipment is delivered without a shipped timestamp`,
            evidence: {
              shipmentId: shipment.id,
              status: shipment.status,
              shippedAt: shipment.shippedAt,
              deliveredAt: shipment.deliveredAt,
            },
            recommendedNextStep:
              "Reconcile shipment lifecycle timestamps with the carrier/platform.",
          }),
        );
      }
    }

    return results;
  }

  // ============================================================
  // ORDER RISKS
  // ============================================================

  private async detectOrderRisks(input: RiskDetectionContext) {
    const orders = await this.prisma.order.findMany({
      where: {
        tenantId: input.tenantId,
        storeId: input.storeId,
        status: {
          notIn: [OrderStatus.CANCELLED],
        },
      },
      include: {
        items: true,
        reservations: true,
        fulfillments: true,
      },
    });

    const results = [];

    for (const order of orders) {
      const activeReservations = order.reservations.filter(
        (reservation) =>
          reservation.status === InventoryReservationStatus.ACTIVE,
      );

      const shippedOrFulfilled =
        order.status === OrderStatus.FULFILLED ||
        order.fulfillmentStatus === "fulfilled";

      if (shippedOrFulfilled && activeReservations.length > 0) {
        results.push(
          await this.raise(input, {
            fingerprint: `order-active-reservation-after-fulfillment:${order.id}`,
            category: "ORDER_INTEGRITY",
            severity: ExceptionSeverity.HIGH,
            title: `Order remains reserved after fulfillment`,
            evidence: {
              orderId: order.id,
              orderNumber: order.orderNumber,
              orderStatus: order.status,
              fulfillmentStatus: order.fulfillmentStatus,
              activeReservationCount: activeReservations.length,
              reservations: activeReservations.map((reservation) => ({
                id: reservation.id,
                quantity: reservation.quantity,
                locationId: reservation.locationId,
              })),
            },
            recommendedNextStep:
              "Reconcile the order reservation lifecycle and release any stale reservation.",
          }),
        );
      }

      if (
        order.status === OrderStatus.FAILED &&
        activeReservations.length > 0
      ) {
        results.push(
          await this.raise(input, {
            fingerprint: `failed-order-with-reservation:${order.id}`,
            category: "ORDER_INTEGRITY",
            severity: ExceptionSeverity.HIGH,
            title: `Failed order still has active inventory reservations`,
            evidence: {
              orderId: order.id,
              orderNumber: order.orderNumber,
              activeReservationCount: activeReservations.length,
            },
            recommendedNextStep:
              "Release the active reservation and verify inventory availability.",
          }),
        );
      }
    }

    return results;
  }

  // ============================================================
  // EXCEPTION CREATION
  // ============================================================

  private async raise(
    input: RiskDetectionContext,
    risk: {
      fingerprint: string;
      category: string;
      severity: ExceptionSeverity;
      title: string;
      evidence: Prisma.InputJsonValue;
      recommendedNextStep: string;
    },
  ) {
    return this.exceptionService.createOrUpdateException({
      tenantId: input.tenantId,
      storeId: input.storeId,
      fingerprint: risk.fingerprint,
      category: risk.category,
      severity: risk.severity,
      title: risk.title,
      evidence: risk.evidence,
      recommendedNextStep: risk.recommendedNextStep,
    });
  }
}

import { Injectable } from "@nestjs/common";
import {
  FulfillmentStatus,
  InventoryReservationStatus,
  ShipmentStatus,
} from "@prisma/client";

import { PrismaService } from "../../prisma/prisma.service";
import { InventoryService } from "../inventory/inventory.service";

import {
  CancelFulfillmentInput,
  CancelShipmentInput,
  CompleteFulfillmentInput,
  CreateFulfillmentInput,
  CreateShipmentInput,
  DeliverShipmentInput,
  FulfillmentContext,
  LabelShipmentInput,
  ShipShipmentInput,
  StartFulfillmentInput,
} from "./fulfillment.types";

@Injectable()
export class FulfillmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventoryService: InventoryService,
  ) {}

  // ============================================================
  // CREATE FULFILLMENT
  // ============================================================

  async create(input: CreateFulfillmentInput) {
    const order = await this.prisma.order.findFirst({
      where: {
        id: input.orderId,
        tenantId: input.tenantId,
        storeId: input.storeId,
      },
      include: {
        items: true,
        reservations: {
          where: {
            status: InventoryReservationStatus.ACTIVE,
            locationId: input.locationId,
          },
        },
      },
    });

    if (!order) {
      throw new Error(`Order not found: ${input.orderId}`);
    }

    if (order.reservations.length === 0) {
      throw new Error(
        `No active inventory reservations found for order ${input.orderId} at location ${input.locationId}`,
      );
    }

    const existing = await this.prisma.fulfillment.findFirst({
      where: {
        tenantId: input.tenantId,
        storeId: input.storeId,
        orderId: input.orderId,
        locationId: input.locationId,
        status: {
          not: FulfillmentStatus.CANCELLED,
        },
      },
      include: {
        items: true,
        shipments: {
          include: {
            items: true,
          },
        },
      },
    });

    if (existing) {
      return existing;
    }

    return this.prisma.$transaction(async (tx) => {
      const fulfillment = await tx.fulfillment.create({
        data: {
          tenantId: input.tenantId,
          storeId: input.storeId,
          orderId: input.orderId,
          locationId: input.locationId,
          status: FulfillmentStatus.READY,

          items: {
            create: order.reservations.map((reservation) => ({
              orderItemId: reservation.orderItemId,
              reservationId: reservation.id,
              inventoryItemId: reservation.inventoryItemId,
              quantity: reservation.quantity,
            })),
          },
        },

        include: {
          items: true,
          shipments: {
            include: {
              items: true,
            },
          },
        },
      });

      return fulfillment;
    });
  }

  // ============================================================
  // CREATE ALL FULFILLMENTS FOR AN ORDER
  // ============================================================

  async createForOrder(input: FulfillmentContext & { orderId: string }) {
    const reservations = await this.prisma.inventoryReservation.findMany({
      where: {
        tenantId: input.tenantId,
        storeId: input.storeId,
        orderId: input.orderId,
        status: InventoryReservationStatus.ACTIVE,
      },
      select: {
        locationId: true,
      },
      distinct: ["locationId"],
    });

    if (reservations.length === 0) {
      throw new Error(
        `No active inventory reservations found for order ${input.orderId}`,
      );
    }

    const fulfillments = [];

    for (const reservation of reservations) {
      fulfillments.push(
        await this.create({
          tenantId: input.tenantId,
          storeId: input.storeId,
          orderId: input.orderId,
          locationId: reservation.locationId,
        }),
      );
    }

    return fulfillments;
  }

  // ============================================================
  // GET
  // ============================================================

  async getById(input: FulfillmentContext & { fulfillmentId: string }) {
    const fulfillment = await this.prisma.fulfillment.findFirst({
      where: {
        id: input.fulfillmentId,
        tenantId: input.tenantId,
        storeId: input.storeId,
      },
      include: {
        order: true,
        location: true,
        items: {
          include: {
            orderItem: true,
            reservation: true,
            inventoryItem: true,
            shipmentItems: true,
          },
        },
        shipments: {
          include: {
            items: true,
          },
        },
      },
    });

    if (!fulfillment) {
      throw new Error(`Fulfillment not found: ${input.fulfillmentId}`);
    }

    return fulfillment;
  }

  // ============================================================
  // START
  // ============================================================

  async start(input: StartFulfillmentInput) {
    const fulfillment = await this.getById(input);

    if (fulfillment.status === FulfillmentStatus.IN_PROGRESS) {
      return fulfillment;
    }

    if (fulfillment.status !== FulfillmentStatus.READY) {
      throw new Error(
        `Cannot start fulfillment from status ${fulfillment.status}`,
      );
    }

    if (fulfillment.items.length === 0) {
      throw new Error("Cannot start fulfillment without items");
    }

    for (const item of fulfillment.items) {
      if (item.quantity <= 0) {
        throw new Error(`Invalid fulfillment quantity for item ${item.id}`);
      }

      if (item.reservation.status !== InventoryReservationStatus.ACTIVE) {
        throw new Error(`Reservation ${item.reservationId} is not ACTIVE`);
      }

      if (item.quantity > item.reservation.quantity) {
        throw new Error(
          `Fulfillment quantity exceeds reservation quantity for item ${item.id}`,
        );
      }
    }

    return this.prisma.fulfillment.update({
      where: {
        id: fulfillment.id,
      },
      data: {
        status: FulfillmentStatus.IN_PROGRESS,
      },
      include: {
        items: true,
        shipments: {
          include: {
            items: true,
          },
        },
      },
    });
  }

  // ============================================================
  // CANCEL
  // ============================================================

  async cancel(input: CancelFulfillmentInput) {
    const fulfillment = await this.getById(input);

    if (fulfillment.status === FulfillmentStatus.CANCELLED) {
      return fulfillment;
    }

    if (
      fulfillment.status !== FulfillmentStatus.READY &&
      fulfillment.status !== FulfillmentStatus.IN_PROGRESS
    ) {
      throw new Error(
        `Cannot cancel fulfillment from status ${fulfillment.status}`,
      );
    }

    /*
     * InventoryService owns reservation release.
     *
     * We do NOT mutate InventoryReservation directly here.
     */
    await this.inventoryService.releaseOrder({
      tenantId: input.tenantId,
      storeId: input.storeId,
      orderId: fulfillment.orderId,
    });

    return this.prisma.fulfillment.update({
      where: {
        id: fulfillment.id,
      },
      data: {
        status: FulfillmentStatus.CANCELLED,
      },
      include: {
        items: true,
        shipments: {
          include: {
            items: true,
          },
        },
      },
    });
  }

  // ============================================================
  // COMPLETE
  // ============================================================

  async complete(input: CompleteFulfillmentInput) {
    const fulfillment = await this.getById(input);

    if (fulfillment.status === FulfillmentStatus.FULFILLED) {
      return fulfillment;
    }

    if (
      fulfillment.status !== FulfillmentStatus.IN_PROGRESS &&
      fulfillment.status !== FulfillmentStatus.PARTIALLY_FULFILLED
    ) {
      throw new Error(
        `Cannot complete fulfillment from status ${fulfillment.status}`,
      );
    }

    const shippedQuantityByItem =
      await this.getShippedQuantityByFulfillmentItem(fulfillment.id);

    let fullyShipped = true;
    let partiallyShipped = false;

    for (const item of fulfillment.items) {
      const shipped = shippedQuantityByItem.get(item.id) ?? 0;

      if (shipped > item.quantity) {
        throw new Error(
          `Shipment quantity exceeds fulfillment quantity for item ${item.id}`,
        );
      }

      if (shipped < item.quantity) {
        fullyShipped = false;

        if (shipped > 0) {
          partiallyShipped = true;
        }
      }
    }

    if (!fullyShipped && !partiallyShipped) {
      throw new Error(
        "Cannot complete fulfillment before any quantity is shipped",
      );
    }

    if (!fullyShipped) {
      return this.prisma.fulfillment.update({
        where: {
          id: fulfillment.id,
        },
        data: {
          status: FulfillmentStatus.PARTIALLY_FULFILLED,
        },
        include: {
          items: true,
          shipments: {
            include: {
              items: true,
            },
          },
        },
      });
    }

    /*
     * InventoryService owns the inventory COMMIT transition.
     *
     * This consumes ACTIVE reservations.
     */
    await this.inventoryService.commitOrder({
      tenantId: input.tenantId,
      storeId: input.storeId,
      orderId: fulfillment.orderId,
    });

    return this.prisma.fulfillment.update({
      where: {
        id: fulfillment.id,
      },
      data: {
        status: FulfillmentStatus.FULFILLED,
      },
      include: {
        items: true,
        shipments: {
          include: {
            items: true,
          },
        },
      },
    });
  }

  // ============================================================
  // CREATE SHIPMENT
  // ============================================================

  async createShipment(input: CreateShipmentInput) {
    const fulfillment = await this.getById(input);

    if (
      fulfillment.status !== FulfillmentStatus.IN_PROGRESS &&
      fulfillment.status !== FulfillmentStatus.PARTIALLY_FULFILLED
    ) {
      throw new Error(
        `Cannot create shipment from fulfillment status ${fulfillment.status}`,
      );
    }

    if (input.items.length === 0) {
      throw new Error("Shipment must contain at least one item");
    }

    for (const item of input.items) {
      if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
        throw new Error(`Shipment quantity must be a positive integer`);
      }

      const fulfillmentItem = fulfillment.items.find(
        (candidate) => candidate.id === item.fulfillmentItemId,
      );

      if (!fulfillmentItem) {
        throw new Error(
          `Fulfillment item not found: ${item.fulfillmentItemId}`,
        );
      }

      const alreadyShipped = await this.getShippedQuantity(fulfillmentItem.id);

      if (alreadyShipped + item.quantity > fulfillmentItem.quantity) {
        throw new Error(
          `Shipment quantity exceeds remaining fulfillment quantity for item ${item.fulfillmentItemId}`,
        );
      }
    }

    if (input.externalShipmentId) {
      const existing = await this.prisma.shipment.findFirst({
        where: {
          storeId: input.storeId,
          externalShipmentId: input.externalShipmentId,
        },
        include: {
          items: true,
        },
      });

      if (existing) {
        return existing;
      }
    }

    return this.prisma.shipment.create({
      data: {
        tenantId: input.tenantId,
        storeId: input.storeId,
        fulfillmentId: fulfillment.id,

        status: ShipmentStatus.CREATED,

        externalShipmentId: input.externalShipmentId,

        carrier: input.carrier,
        service: input.service,

        trackingNumber: input.trackingNumber,

        trackingUrl: input.trackingUrl,

        items: {
          create: input.items.map((item) => {
            const fulfillmentItem = fulfillment.items.find(
              (candidate) => candidate.id === item.fulfillmentItemId,
            );

            if (!fulfillmentItem) {
              throw new Error(
                `Fulfillment item not found: ${item.fulfillmentItemId}`,
              );
            }

            return {
              fulfillmentItemId: fulfillmentItem.id,
              orderItemId: fulfillmentItem.orderItemId,
              quantity: item.quantity,
            };
          }),
        },
      },

      include: {
        items: true,
      },
    });
  }

  // ============================================================
  // SHIP SHIPMENT
  // ============================================================

  async shipShipment(input: ShipShipmentInput) {
    const shipment = await this.prisma.shipment.findFirst({
      where: {
        id: input.shipmentId,
        tenantId: input.tenantId,
        storeId: input.storeId,
      },
      include: {
        fulfillment: true,
        items: true,
      },
    });

    if (!shipment) {
      throw new Error(`Shipment not found: ${input.shipmentId}`);
    }

    if (shipment.status === ShipmentStatus.IN_TRANSIT) {
      return shipment;
    }

    if (
      shipment.status !== ShipmentStatus.CREATED &&
      shipment.status !== ShipmentStatus.LABEL_CREATED
    ) {
      throw new Error(`Cannot ship shipment from status ${shipment.status}`);
    }

    /*
     * InventoryService owns the final inventory SHIP
     * transition.
     *
     * This changes COMMITTED → SHIPPED.
     */
    await this.inventoryService.shipOrder({
      tenantId: input.tenantId,
      storeId: input.storeId,
      orderId: shipment.fulfillment.orderId,
    });

    return this.prisma.shipment.update({
      where: {
        id: shipment.id,
      },
      data: {
        status: ShipmentStatus.IN_TRANSIT,
        shippedAt: new Date(),
      },
      include: {
        items: true,
      },
    });
  }

  // ============================================================
  // LABEL SHIPMENT
  // ============================================================

  async labelShipment(input: LabelShipmentInput) {
    const shipment = await this.prisma.shipment.findFirst({
      where: {
        id: input.shipmentId,
        tenantId: input.tenantId,
        storeId: input.storeId,
      },
      include: {
        items: true,
      },
    });

    if (!shipment) {
      throw new Error(`Shipment not found: ${input.shipmentId}`);
    }

    if (shipment.status === ShipmentStatus.LABEL_CREATED) {
      return shipment;
    }

    if (shipment.status !== ShipmentStatus.CREATED) {
      throw new Error(`Cannot label shipment from status ${shipment.status}`);
    }

    return this.prisma.shipment.update({
      where: {
        id: shipment.id,
      },
      data: {
        status: ShipmentStatus.LABEL_CREATED,
      },
      include: {
        items: true,
      },
    });
  }

  // ============================================================
  // DELIVER SHIPMENT
  // ============================================================

  async deliverShipment(input: DeliverShipmentInput) {
    const shipment = await this.prisma.shipment.findFirst({
      where: {
        id: input.shipmentId,
        tenantId: input.tenantId,
        storeId: input.storeId,
      },
      include: {
        fulfillment: true,
        items: true,
      },
    });

    if (!shipment) {
      throw new Error(`Shipment not found: ${input.shipmentId}`);
    }

    if (shipment.status === ShipmentStatus.DELIVERED) {
      return shipment;
    }

    if (shipment.status !== ShipmentStatus.IN_TRANSIT) {
      throw new Error(`Cannot deliver shipment from status ${shipment.status}`);
    }

    return this.prisma.shipment.update({
      where: {
        id: shipment.id,
      },
      data: {
        status: ShipmentStatus.DELIVERED,
        deliveredAt: new Date(),
      },
      include: {
        items: true,
      },
    });
  }
  // ============================================================
  // CANCEL SHIPMENT
  // ============================================================

  async cancelShipment(input: CancelShipmentInput) {
    const shipment = await this.prisma.shipment.findFirst({
      where: {
        id: input.shipmentId,
        tenantId: input.tenantId,
        storeId: input.storeId,
      },
      include: {
        items: true,
      },
    });

    if (!shipment) {
      throw new Error(`Shipment not found: ${input.shipmentId}`);
    }

    if (shipment.status === ShipmentStatus.CANCELLED) {
      return shipment;
    }

    if (
      shipment.status !== ShipmentStatus.CREATED &&
      shipment.status !== ShipmentStatus.LABEL_CREATED
    ) {
      throw new Error(`Cannot cancel shipment from status ${shipment.status}`);
    }

    return this.prisma.shipment.update({
      where: {
        id: shipment.id,
      },
      data: {
        status: ShipmentStatus.CANCELLED,
      },
      include: {
        items: true,
      },
    });
  }

  // ============================================================
  // SHIPPED QUANTITY
  // ============================================================

  private async getShippedQuantity(fulfillmentItemId: string) {
    const result = await this.prisma.shipmentItem.aggregate({
      where: {
        fulfillmentItemId,
        shipment: {
          status: {
            in: [
              ShipmentStatus.CREATED,
              ShipmentStatus.LABEL_CREATED,
              ShipmentStatus.IN_TRANSIT,
              ShipmentStatus.DELIVERED,
            ],
          },
        },
      },
      _sum: {
        quantity: true,
      },
    });

    return result._sum.quantity ?? 0;
  }

  private async getShippedQuantityByFulfillmentItem(fulfillmentId: string) {
    const items = await this.prisma.shipmentItem.findMany({
      where: {
        fulfillmentItem: {
          fulfillmentId,
        },
        shipment: {
          status: {
            in: [
              ShipmentStatus.CREATED,
              ShipmentStatus.LABEL_CREATED,
              ShipmentStatus.IN_TRANSIT,
              ShipmentStatus.DELIVERED,
            ],
          },
        },
      },
      select: {
        fulfillmentItemId: true,
        quantity: true,
      },
    });

    const result = new Map<string, number>();

    for (const item of items) {
      result.set(
        item.fulfillmentItemId,
        (result.get(item.fulfillmentItemId) ?? 0) + item.quantity,
      );
    }

    return result;
  }
}

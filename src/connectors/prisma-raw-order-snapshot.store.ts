import { Prisma } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";

import {
  RawOrderSnapshotRecord,
  RawOrderSnapshotStore,
} from "./raw-order-snapshot.port";

/**
 * Prisma-backed implementation of the raw order snapshot port.
 *
 * This is the only place the raw snapshot write touches persistence. The
 * upsert arguments are byte-identical to what ShopifyConnector used to
 * write directly (asserted by shopify-snapshot-parity.spec.ts): the write
 * stays keyed on the channel's order id and updates the mutable fields on
 * redelivery.
 */
export class PrismaRawOrderSnapshotStore implements RawOrderSnapshotStore {
  constructor(private readonly prisma: PrismaService) {}

  async upsert(record: RawOrderSnapshotRecord): Promise<void> {
    await this.prisma.shopifyOrderSnapshot.upsert({
      where: {
        storeId_shopifyOrderId: {
          storeId: record.storeId,
          shopifyOrderId: record.externalOrderId,
        },
      },
      create: {
        tenantId: record.tenantId,
        storeId: record.storeId,
        shopifyOrderId: record.externalOrderId,
        orderName: record.orderName,
        financialStatus: record.financialStatus,
        fulfillmentStatus: record.fulfillmentStatus,
        raw: record.rawPayload as Prisma.InputJsonValue,
        createdAtShopify: record.externalCreatedAt,
        updatedAtShopify: record.externalUpdatedAt,
      },
      update: {
        orderName: record.orderName,
        financialStatus: record.financialStatus,
        fulfillmentStatus: record.fulfillmentStatus,
        raw: record.rawPayload as Prisma.InputJsonValue,
        updatedAtShopify: record.externalUpdatedAt,
      },
    });
  }
}
